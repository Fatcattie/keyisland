//! 本地持久化层。
//!
//! 设计要点（安全相关，改动前先读完）：
//!
//! 1. **每个值独立加密**：`kv` 表里只有 `(键名, 密文)`，密文是
//!    `base64(nonce ‖ AES-256-GCM(key, aad = 键名, 明文))`。列表里 item 的
//!    `title` / `platform` / `tags` 都是明文（见 `EncryptedItemRecord`），
//!    所以整库必须加密，不能只加密账号密码字段。
//! 2. **AAD 绑定键名**：把 `items` 的密文挪到 `meta` 行会解密失败，
//!    避免"改一行数据让应用读到另一份内容"这类拼接攻击。
//! 3. **数据库密钥不落盘**：32 字节随机密钥存进 Windows 凭据管理器
//!    （底层 DPAPI，按当前用户绑定）。拿到 `vault.db` 文件本身解不开。
//! 4. **密钥丢了就不许新建**：`kv` 表里已有密文而凭据管理器里没有密钥时，
//!    `missing_key_policy` 会拒绝启动。否则新密钥解不开旧密文，后续写入还会
//!    让新旧密文混进同一张表——数据永久不可恢复，而报错只说"可能被篡改"。
//! 5. 这一层**不碰用户主密码**。主密码只负责解开密钥槽里的 DEK，
//!    数据库密钥是另一把独立的钥匙——两者任一丢失都无法还原数据，
//!    这也是"换机器要导出备份"的原因。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};

/// 凭据管理器里的条目名。改这个等于让所有老用户的库"消失"，别动。
const KEYRING_SERVICE: &str = "KeyIsland";
const KEYRING_USER: &str = "storage-key";

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// 启动阶段可能的失败。
///
/// 为什么要分类而不是直接用一个 `String`：这些失败对用户的含义完全不同。
/// 「凭据管理器里密钥没了」要引导用户找回凭据或导备份，「数据目录建不出来」
/// 要引导用户看磁盘权限——都压成一句"存储读写失败"，用户除了重试无事可做。
/// `code` 给 UI 选文案，`detail` 给人看具体原因。
#[derive(Debug)]
pub enum StartupError {
    /// 库里已有密文，但凭据管理器里没有密钥。最需要用户看懂的一类。
    MissingKey(String),
    /// 凭据管理器本身访问不了（权限、服务异常、条目损坏）。
    Credential(String),
    /// 数据目录建不出来（磁盘满、无权限、被组策略拦）。
    DataDir(String),
    /// 数据库文件打不开或初始化失败（被占用、只读、文件损坏）。
    Database(String),
}

impl StartupError {
    /// 给前端做分支用的稳定标识，改了要同步 `tauri-storage.ts`。
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingKey(_) => "missing_key",
            Self::Credential(_) => "credential",
            Self::DataDir(_) => "data_dir",
            Self::Database(_) => "database",
        }
    }

    /// 面向用户的中文原因。刻意不含 SQL / 加密库内部细节之外的东西。
    pub fn detail(&self) -> &str {
        match self {
            Self::MissingKey(message)
            | Self::Credential(message)
            | Self::DataDir(message)
            | Self::Database(message) => message,
        }
    }
}

/// 本地加密键值库。
///
/// 刻意不存 `db_path`：路径的唯一来源是 `lib.rs` 的 `AppState`。
/// `Store` 在启动失败时压根不存在，而那时最需要知道"数据在哪"——
/// 两处各存一份只会让"失败时也要能显示路径"变成不可能。
pub struct Store {
    conn: Mutex<Connection>,
    key: [u8; KEY_LEN],
}

impl Store {
    pub fn open(db_path: PathBuf) -> Result<Self, StartupError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| StartupError::DataDir(format!("创建数据目录失败：{error}")))?;
        }

        let conn = Connection::open(&db_path)
            .map_err(|error| StartupError::Database(format!("打开数据库失败：{error}")))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS kv (
                 k TEXT PRIMARY KEY NOT NULL,
                 v TEXT NOT NULL
             );",
        )
        .map_err(|error| StartupError::Database(format!("初始化数据库失败：{error}")))?;

        // 顺序很关键：**先建表 → 再数行 → 最后取密钥**。
        //
        // 原先第一步就是取密钥，于是有一个静默的数据毁灭路径：`kv` 里已有密文，
        // 但凭据管理器里的条目没了（换用户、重装系统、清理凭据都会），
        // `load_or_create_key` 会当成"首次运行"直接生成一把新密钥。新密钥解不开
        // 旧密文，而之后任何一次写入都会把新旧密文混进同一张表——数据从此永久
        // 不可恢复，用户看到的却只是一句"解密失败：数据可能被篡改，或换过机器"。
        let existing_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM kv", (), |row| row.get(0))
            .map_err(|error| StartupError::Database(format!("读取数据库状态失败：{error}")))?;

        let key = load_or_create_key(existing_rows > 0)?;

        Ok(Self {
            conn: Mutex::new(conn),
            key,
        })
    }

    /// 测试专用：用给定密钥打开，绕过凭据管理器，以便在隔离目录里跑真实 SQLite。
    #[cfg(test)]
    fn open_with_key(db_path: &std::path::Path, key: [u8; KEY_LEN]) -> Self {
        let conn = Connection::open(db_path).expect("打开测试数据库");
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS kv (
                 k TEXT PRIMARY KEY NOT NULL,
                 v TEXT NOT NULL
             );",
        )
        .expect("初始化测试数据库");
        Self {
            conn: Mutex::new(conn),
            key,
        }
    }

    pub fn get(&self, key_name: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|_| "数据库锁失效".to_string())?;
        let stored: Option<String> = conn
            .query_row("SELECT v FROM kv WHERE k = ?1", params![key_name], |row| row.get(0))
            .optional()
            .map_err(|error| format!("读取失败：{error}"))?;

        match stored {
            None => Ok(None),
            Some(ciphertext) => Ok(Some(decrypt(&self.key, key_name, &ciphertext)?)),
        }
    }

    pub fn set(&self, key_name: &str, plaintext: &str) -> Result<(), String> {
        let ciphertext = encrypt(&self.key, key_name, plaintext)?;
        let conn = self.conn.lock().map_err(|_| "数据库锁失效".to_string())?;
        conn.execute(
            "INSERT INTO kv (k, v) VALUES (?1, ?2)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![key_name, ciphertext],
        )
        .map_err(|error| format!("写入失败：{error}"))?;
        Ok(())
    }

    /// 读取全部资产（每张卡片一行，`item:<id>`），按 id 升序返回各自的 JSON。
    ///
    /// 库里若还是旧布局（一整行 `items` 存全部卡片），先在**一个事务**里迁成
    /// 新布局再读；迁移失败时事务回滚，旧行原样保留，下次还能再试。
    pub fn load_items(&self) -> Result<Vec<String>, String> {
        let mut conn = self.conn.lock().map_err(|_| "数据库锁失效".to_string())?;
        migrate_legacy_items(&mut conn, &self.key)?;

        let mut stmt = conn
            .prepare("SELECT k, v FROM kv WHERE k LIKE 'item:%'")
            .map_err(|error| format!("读取失败：{error}"))?;
        let rows = stmt
            .query_map((), |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| format!("读取失败：{error}"))?;

        let mut items: Vec<(u64, String)> = Vec::new();
        for row in rows {
            let (key_name, ciphertext) = row.map_err(|error| format!("读取失败：{error}"))?;
            let id = parse_item_key(&key_name).ok_or_else(|| format!("资产行键名异常：{key_name}"))?;
            // AAD 是完整键名 `item:<id>`：把一张卡片的密文挪到另一行会解密失败。
            items.push((id, decrypt(&self.key, &key_name, &ciphertext)?));
        }
        items.sort_by_key(|(id, _)| *id);
        Ok(items.into_iter().map(|(_, json)| json).collect())
    }

    /// 原子提交一批写入：要么全部生效，要么一个都不生效。
    ///
    /// 整库初始化、覆盖导入、重设主密码（密钥槽 + 提示）以及资产的增量增删改
    /// 都走这里。所有加密与校验都在开启事务**之前**完成，事务里只剩 SQL；
    /// 任何一步出错，`Transaction` 在 drop 时回滚，磁盘上还是提交前的样子。
    pub fn commit(&self, batch: &CommitBatch) -> Result<(), String> {
        self.commit_with_fault(batch, None)
    }

    /// `fail_before_write`：测试用的故障注入点，在第 N 条写语句执行前返回错误，
    /// 用来证明"写到一半出错"不会留下混合状态。生产路径恒为 `None`。
    fn commit_with_fault(&self, batch: &CommitBatch, fail_before_write: Option<usize>) -> Result<(), String> {
        let mut rows: Vec<(String, String)> = Vec::with_capacity(batch.puts.len() + batch.item_upserts.len());
        let mut seen: HashSet<String> = HashSet::with_capacity(rows.capacity());
        let deletes: HashSet<u64> = batch.item_deletes.iter().copied().collect();
        for (key_name, plaintext) in &batch.puts {
            if key_name.starts_with(ITEM_PREFIX) || key_name == LEGACY_ITEMS_KEY {
                return Err(format!("资产必须走增量接口写入：{key_name}"));
            }
            if !seen.insert(key_name.clone()) {
                return Err(format!("同一批写入里重复的键：{key_name}"));
            }
            rows.push((key_name.clone(), encrypt(&self.key, key_name, plaintext)?));
        }
        for (id, json) in &batch.item_upserts {
            validate_item_json(*id, json)?;
            let key_name = item_key(*id);
            if !seen.insert(key_name.clone()) {
                return Err(format!("同一批写入里重复的资产：{id}"));
            }
            if deletes.contains(id) {
                return Err(format!("同一批里既写入又删除同一资产：{id}"));
            }
            rows.push((key_name.clone(), encrypt(&self.key, &key_name, json)?));
        }

        let mut conn = self.conn.lock().map_err(|_| "数据库锁失效".to_string())?;
        let touches_items = batch.replace_items || !batch.item_upserts.is_empty() || !batch.item_deletes.is_empty();
        if touches_items && !batch.replace_items {
            // 增量写之前先把旧布局迁走，否则新旧两种行会同时存在。
            // 迁移本身是独立事务：迁移成功、本次写入失败时，库是"迁移完的旧数据"，仍然完整可读。
            migrate_legacy_items(&mut conn, &self.key)?;
        }

        let tx = conn.transaction().map_err(|error| format!("开启事务失败：{error}"))?;
        let mut write_index = 0usize;

        if batch.replace_items {
            fault_point(fail_before_write, &mut write_index)?;
            tx.execute(
                "DELETE FROM kv WHERE k LIKE 'item:%' OR k = ?1",
                params![LEGACY_ITEMS_KEY],
            )
            .map_err(|error| format!("写入失败：{error}"))?;
        }
        for id in &batch.item_deletes {
            fault_point(fail_before_write, &mut write_index)?;
            tx.execute("DELETE FROM kv WHERE k = ?1", params![item_key(*id)])
                .map_err(|error| format!("写入失败：{error}"))?;
        }
        for (key_name, ciphertext) in &rows {
            fault_point(fail_before_write, &mut write_index)?;
            tx.execute(
                "INSERT INTO kv (k, v) VALUES (?1, ?2)
                 ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                params![key_name, ciphertext],
            )
            .map_err(|error| format!("写入失败：{error}"))?;
        }
        tx.commit().map_err(|error| format!("提交事务失败：{error}"))?;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "数据库锁失效".to_string())?;
        // 用 execute_batch 而不是 `execute(sql, [])`：空数组字面量要过 `Params`
        // 的泛型实现做类型推断，不同 rusqlite 版本上时好时坏。这里没有参数，
        // 干脆走不需要推断的那条路。
        conn.execute_batch("DELETE FROM kv").map_err(|error| format!("清空失败：{error}"))?;
        // VACUUM 让被删除的页真正落回磁盘，否则旧密文还留在空闲页里。
        // 必须在事务之外执行，所以不能和上面的 DELETE 合并成一个 batch。
        conn.execute_batch("VACUUM;").map_err(|error| format!("整理数据库失败：{error}"))?;
        Ok(())
    }
}

/// 测试故障注入点：第 `fail_at` 条写语句之前返回错误。生产路径传 `None`，恒为空操作。
fn fault_point(fail_at: Option<usize>, index: &mut usize) -> Result<(), String> {
    if fail_at == Some(*index) {
        return Err("模拟写入失败".to_string());
    }
    *index += 1;
    Ok(())
}

/// 资产行键名前缀：每张卡片一行，`item:<id>`。
pub const ITEM_PREFIX: &str = "item:";
/// 0.1.20 及以前的旧布局：全部卡片挤在这一行里。只读不写，读到就迁移。
pub const LEGACY_ITEMS_KEY: &str = "items";

/// 一批原子写入。字段语义与前端 `VaultWriteBatch` / `ItemChangeSet` 对应。
#[derive(Debug, Default)]
pub struct CommitBatch {
    /// 普通键（keyslots / meta / recency）的明文 JSON。
    pub puts: Vec<(String, String)>,
    /// 为 true 时先删光全部资产行（含旧布局行），再写 `item_upserts`：整体替换。
    pub replace_items: bool,
    /// `(id, 该卡片的 JSON)`。
    pub item_upserts: Vec<(u64, String)>,
    pub item_deletes: Vec<u64>,
}

pub fn item_key(id: u64) -> String {
    format!("{ITEM_PREFIX}{id}")
}

fn parse_item_key(key_name: &str) -> Option<u64> {
    let digits = key_name.strip_prefix(ITEM_PREFIX)?;
    // 只认规范十进制：拒绝 "+1"、"01" 这类能映射到同一 id 的别名。
    if digits.is_empty()
        || (digits.len() > 1 && digits.starts_with('0'))
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    digits.parse().ok()
}

/// 资产 JSON 必须是对象，且其中的 `id` 与行身份一致——行与内容对不上时，
/// 前端会按内容里的 id 解密（字段 AAD 绑定 id），结果是一张解不开的卡。
fn validate_item_json(id: u64, json: &str) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| format!("资产 {id} 不是合法 JSON"))?;
    match value.get("id").and_then(serde_json::Value::as_u64) {
        Some(inner) if inner == id => Ok(()),
        _ => Err(format!("资产 {id} 的内容与行身份不一致")),
    }
}

/// 把旧布局（一行 `items` 存整个数组）原子地拆成每卡一行。
///
/// - 没有旧行：什么都不做；
/// - 旧行与新行**同时存在**：拒绝。这只会出现在"升级后又装回旧版本、旧版本又写过一次"
///   的情况，两份数据谁新谁旧无从判断，id 还可能撞车。替用户选一份等于静默丢另一份，
///   所以宁可报错、两份都原样保留，让用户先导出备份再处理；
/// - 任何一步失败：事务回滚，旧行原样保留，下次还能再试。
fn migrate_legacy_items(conn: &mut Connection, key: &[u8; KEY_LEN]) -> Result<(), String> {
    let legacy: Option<String> = conn
        .query_row("SELECT v FROM kv WHERE k = ?1", params![LEGACY_ITEMS_KEY], |row| row.get(0))
        .optional()
        .map_err(|error| format!("读取失败：{error}"))?;
    let Some(ciphertext) = legacy else {
        return Ok(());
    };
    let plaintext = decrypt(key, LEGACY_ITEMS_KEY, &ciphertext)?;
    let records = split_legacy_items(&plaintext)?;

    let tx = conn.transaction().map_err(|error| format!("开启事务失败：{error}"))?;
    let existing: i64 = tx
        .query_row("SELECT COUNT(*) FROM kv WHERE k LIKE 'item:%'", (), |row| row.get(0))
        .map_err(|error| format!("读取失败：{error}"))?;
    if existing > 0 {
        return Err(
            "数据库里同时存在旧版与新版的资产数据（可能装回过旧版本），为避免互相覆盖已停止迁移"
                .to_string(),
        );
    }
    for (id, json) in &records {
        let key_name = item_key(*id);
        let packed = encrypt(key, &key_name, json)?;
        tx.execute("INSERT INTO kv (k, v) VALUES (?1, ?2)", params![key_name, packed])
            .map_err(|error| format!("迁移写入失败：{error}"))?;
    }
    tx.execute("DELETE FROM kv WHERE k = ?1", params![LEGACY_ITEMS_KEY])
        .map_err(|error| format!("迁移写入失败：{error}"))?;
    tx.commit().map_err(|error| format!("提交迁移失败：{error}"))?;
    Ok(())
}

/// 把旧布局的 JSON 数组拆成 `(id, 单卡 JSON)`。缺 id 或重复 id 一律拒绝。
fn split_legacy_items(plaintext: &str) -> Result<Vec<(u64, String)>, String> {
    let value: serde_json::Value =
        serde_json::from_str(plaintext).map_err(|_| "旧版资产数据不是合法 JSON".to_string())?;
    let array = value.as_array().ok_or_else(|| "旧版资产数据不是数组".to_string())?;
    let mut seen = HashSet::with_capacity(array.len());
    let mut records = Vec::with_capacity(array.len());
    for element in array {
        let id = element
            .get("id")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "旧版资产数据里有缺少 id 的记录".to_string())?;
        if !seen.insert(id) {
            return Err(format!("旧版资产数据里有重复的 id：{id}"));
        }
        let json = serde_json::to_string(element).map_err(|error| format!("序列化失败：{error}"))?;
        records.push((id, json));
    }
    Ok(records)
}

fn encrypt(key: &[u8; KEY_LEN], key_name: &str, plaintext: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| format!("初始化加密器失败：{error}"))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: key_name.as_bytes(),
            },
        )
        .map_err(|_| "加密失败".to_string())?;

    let mut packed = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(packed))
}

fn decrypt(key: &[u8; KEY_LEN], key_name: &str, packed: &str) -> Result<String, String> {
    let raw = BASE64.decode(packed).map_err(|error| format!("密文格式错误：{error}"))?;
    if raw.len() <= NONCE_LEN {
        return Err("密文长度异常".to_string());
    }

    let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| format!("初始化解密器失败：{error}"))?;

    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: ciphertext,
                aad: key_name.as_bytes(),
            },
        )
        .map_err(|_| "解密失败：数据可能被篡改，或换过机器".to_string())?;

    String::from_utf8(plaintext).map_err(|error| format!("内容不是合法 UTF-8：{error}"))
}

/// 凭据管理器里没有密钥时的处置规则。
///
/// `vault_has_data` 为 true 表示 `kv` 表里已经有密文。此时**绝不能新建密钥**：
/// 新密钥解不开旧密文，而后续写入会让新旧密文混在同一张表里，数据永久不可恢复。
/// 宁可拒绝启动、让人来处理，也不要"看起来启动成功、其实数据已经废了"。
fn missing_key_policy(vault_has_data: bool) -> Result<(), StartupError> {
    if vault_has_data {
        Err(StartupError::MissingKey(
            "数据库里已有数据，但系统凭据管理器里找不到对应的密钥。\
             可能换过 Windows 用户、重装过系统，或凭据条目被清理。\
             为避免覆盖既有数据，应用不会新建密钥——请恢复凭据条目，或从备份导入。"
                .to_string(),
        ))
    } else {
        Ok(())
    }
}

/// 读取数据库密钥；首次运行时生成并写入凭据管理器。
#[cfg(windows)]
fn load_or_create_key(vault_has_data: bool) -> Result<[u8; KEY_LEN], StartupError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| StartupError::Credential(format!("访问凭据管理器失败：{error}")))?;

    match entry.get_password() {
        Ok(existing) => decode_key(&existing),
        Err(keyring::Error::NoEntry) => {
            missing_key_policy(vault_has_data)?;
            let mut key = [0u8; KEY_LEN];
            rand::thread_rng().fill_bytes(&mut key);
            entry
                .set_password(&BASE64.encode(key))
                .map_err(|error| StartupError::Credential(format!("写入凭据管理器失败：{error}")))?;
            Ok(key)
        }
        Err(error) => Err(StartupError::Credential(format!("读取数据库密钥失败：{error}"))),
    }
}

/// 非 Windows 平台（仅开发调试用）明确报错，不静默退化成明文密钥。
#[cfg(not(windows))]
fn load_or_create_key(_vault_has_data: bool) -> Result<[u8; KEY_LEN], StartupError> {
    Err(StartupError::Credential(
        "当前仅支持 Windows：数据库密钥依赖 Windows 凭据管理器".to_string(),
    ))
}

fn decode_key(encoded: &str) -> Result<[u8; KEY_LEN], StartupError> {
    let raw = BASE64
        .decode(encoded.trim())
        .map_err(|error| StartupError::Credential(format!("密钥格式错误：{error}")))?;
    if raw.len() != KEY_LEN {
        return Err(StartupError::Credential(format!(
            "密钥长度异常：期望 {KEY_LEN} 字节，实际 {}",
            raw.len()
        )));
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&raw);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_same_key() {
        let key = [7u8; KEY_LEN];
        let packed = encrypt(&key, "items", "[]").expect("加密");
        assert_ne!(packed, "[]");
        assert_eq!(decrypt(&key, "items", &packed).expect("解密"), "[]");
    }

    #[test]
    fn wrong_key_name_fails() {
        let key = [7u8; KEY_LEN];
        let packed = encrypt(&key, "items", "[]").expect("加密");
        // AAD 绑定了键名：把 items 的密文挪到 meta 行必须解不开。
        assert!(decrypt(&key, "meta", &packed).is_err());
    }

    #[test]
    fn wrong_key_fails() {
        let packed = encrypt(&[7u8; KEY_LEN], "items", "[]").expect("加密");
        assert!(decrypt(&[8u8; KEY_LEN], "items", &packed).is_err());
    }

    #[test]
    fn nonce_is_random() {
        let key = [7u8; KEY_LEN];
        let first = encrypt(&key, "items", "same").expect("加密");
        let second = encrypt(&key, "items", "same").expect("加密");
        assert_ne!(first, second, "nonce 必须每次随机，否则同明文会产生相同密文");
    }

    #[test]
    fn missing_key_with_existing_data_refuses() {
        // 库里已有密文、凭据管理器里却没有密钥：绝不能新建。
        // 新密钥解不开旧数据，而后续写入会让新旧密文混在一张表里，永久不可恢复。
        assert!(missing_key_policy(true).is_err());
    }

    #[test]
    fn missing_key_with_empty_vault_is_allowed() {
        // 全新安装（或用户刚清空过库）没有数据可丢，生成新密钥是对的。
        assert!(missing_key_policy(false).is_ok());
    }

    #[test]
    fn startup_errors_are_classified() {
        // code 是前端选文案的唯一依据，detail 是给人看的原因。两者都必须有值：
        // 少一个，UI 就只能退回"存储读写失败，请重试"——正是本次要消灭的文案。
        let cases = [
            (StartupError::MissingKey("x".to_string()), "missing_key"),
            (StartupError::Credential("x".to_string()), "credential"),
            (StartupError::DataDir("x".to_string()), "data_dir"),
            (StartupError::Database("x".to_string()), "database"),
        ];
        for (error, expected) in cases {
            assert_eq!(error.code(), expected);
            assert_eq!(error.detail(), "x");
        }
    }

    // ---- 真实 SQLite 事务测试（任务 1 / 任务 5）----
    //
    // 每个测试一个隔离目录，只写合成数据，绝不碰 `%APPDATA%` 下的真实库。

    const TEST_KEY: [u8; KEY_LEN] = [42u8; KEY_LEN];

    struct TempDb {
        dir: PathBuf,
    }

    impl TempDb {
        fn new(name: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "keyisland-storage-test-{name}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("创建隔离目录");
            Self { dir }
        }

        fn path(&self) -> PathBuf {
            self.dir.join("vault.db")
        }

        fn open(&self) -> Store {
            Store::open_with_key(&self.path(), TEST_KEY)
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn item_json(id: u64, title: &str) -> String {
        format!(r#"{{"id":{id},"title":"{title}"}}"#)
    }

    fn full_batch(generation: &str, ids: &[u64]) -> CommitBatch {
        CommitBatch {
            puts: vec![
                ("keyslots".to_string(), format!(r#"{{"gen":"{generation}"}}"#)),
                ("meta".to_string(), format!(r#"{{"gen":"{generation}"}}"#)),
                ("recency".to_string(), "[]".to_string()),
            ],
            replace_items: true,
            item_upserts: ids.iter().map(|id| (*id, item_json(*id, generation))).collect(),
            item_deletes: Vec::new(),
        }
    }

    /// 读出整库快照，用来断言"要么全旧、要么全新"。
    fn snapshot(store: &Store) -> (Option<String>, Option<String>, Vec<String>) {
        (
            store.get("keyslots").expect("读 keyslots"),
            store.get("meta").expect("读 meta"),
            store.load_items().expect("读 items"),
        )
    }

    #[test]
    fn commit_persists_across_reopen() {
        let db = TempDb::new("reopen");
        {
            let store = db.open();
            store.commit(&full_batch("new", &[1, 2, 10])).expect("提交");
        }
        let store = db.open();
        let (keyslots, meta, items) = snapshot(&store);
        assert_eq!(keyslots.as_deref(), Some(r#"{"gen":"new"}"#));
        assert_eq!(meta.as_deref(), Some(r#"{"gen":"new"}"#));
        // 按 id 数值升序，而不是按键名字典序（否则 10 会排在 2 前面）。
        assert_eq!(items, vec![item_json(1, "new"), item_json(2, "new"), item_json(10, "new")]);
    }

    #[test]
    fn failure_at_every_write_stage_keeps_old_vault() {
        let db = TempDb::new("stages");
        let store = db.open();
        store.commit(&full_batch("old", &[1, 2])).expect("写入旧库");
        let before = snapshot(&store);

        // 覆盖批次的写语句：1 条整体删除 + 3 个普通键 + 3 张卡片 = 7 条。
        let replacement = full_batch("new", &[7, 8, 9]);
        for stage in 0..7 {
            let result = store.commit_with_fault(&replacement, Some(stage));
            assert!(result.is_err(), "第 {stage} 步注入故障必须失败");
            assert_eq!(snapshot(&store), before, "第 {stage} 步失败后出现了混合状态");
        }
        drop(store);
        // 重新打开数据库，结果仍是完整旧库。
        assert_eq!(snapshot(&db.open()), before);
    }

    #[test]
    fn uncommitted_transaction_is_discarded_when_connection_closes() {
        let db = TempDb::new("abandon");
        {
            let store = db.open();
            store.commit(&full_batch("old", &[1])).expect("写入旧库");
        }
        {
            // 模拟"写到一半进程没了"：开事务、写入新密钥槽和新卡片，既不提交也不回滚，
            // 直接丢弃事务句柄并关闭连接。
            let mut conn = Connection::open(db.path()).expect("打开");
            let tx = conn.transaction().expect("开事务");
            tx.execute(
                "INSERT INTO kv (k, v) VALUES ('keyslots', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                params![encrypt(&TEST_KEY, "keyslots", r#"{"gen":"new"}"#).expect("加密")],
            )
            .expect("写 keyslots");
            tx.execute(
                "INSERT INTO kv (k, v) VALUES ('item:5', ?1)",
                params![encrypt(&TEST_KEY, "item:5", &item_json(5, "new")).expect("加密")],
            )
            .expect("写 item");
            std::mem::forget(tx);
            drop(conn);
        }
        let store = db.open();
        let (keyslots, _, items) = snapshot(&store);
        assert_eq!(keyslots.as_deref(), Some(r#"{"gen":"old"}"#));
        assert_eq!(items, vec![item_json(1, "old")]);
    }

    #[test]
    fn incremental_changes_touch_only_named_items() {
        let db = TempDb::new("incremental");
        let store = db.open();
        store.commit(&full_batch("old", &[1, 2, 3])).expect("写入");

        let row_before = |id: u64| -> String {
            let conn = store.conn.lock().expect("锁");
            conn.query_row("SELECT v FROM kv WHERE k = ?1", params![item_key(id)], |row| row.get(0))
                .expect("读原始密文")
        };
        let untouched = row_before(3);

        store
            .commit(&CommitBatch {
                item_upserts: vec![(1, item_json(1, "edited")), (4, item_json(4, "added"))],
                item_deletes: vec![2],
                ..CommitBatch::default()
            })
            .expect("增量提交");

        assert_eq!(
            store.load_items().expect("读"),
            vec![item_json(1, "edited"), item_json(3, "old"), item_json(4, "added")]
        );
        // 没被提及的卡片连密文都不变（nonce 随机，重写过就一定不同）。
        assert_eq!(row_before(3), untouched);
    }

    #[test]
    fn incremental_batch_failure_is_all_or_nothing() {
        let db = TempDb::new("bulk");
        let store = db.open();
        store.commit(&full_batch("old", &[1, 2, 3])).expect("写入");
        let before = store.load_items().expect("读");
        let bulk = CommitBatch {
            item_deletes: vec![1, 2],
            item_upserts: vec![(9, item_json(9, "new"))],
            ..CommitBatch::default()
        };
        for stage in 0..3 {
            assert!(store.commit_with_fault(&bulk, Some(stage)).is_err());
            assert_eq!(store.load_items().expect("读"), before);
        }
    }

    #[test]
    fn rejects_mismatched_or_duplicate_items_before_writing() {
        let db = TempDb::new("validate");
        let store = db.open();
        store.commit(&full_batch("old", &[1])).expect("写入");
        let before = snapshot(&store);

        let mismatched = CommitBatch {
            item_upserts: vec![(2, item_json(3, "x"))],
            ..CommitBatch::default()
        };
        assert!(store.commit(&mismatched).is_err());
        let duplicate = CommitBatch {
            item_upserts: vec![(2, item_json(2, "a")), (2, item_json(2, "b"))],
            ..CommitBatch::default()
        };
        assert!(store.commit(&duplicate).is_err());
        let both = CommitBatch {
            item_upserts: vec![(1, item_json(1, "a"))],
            item_deletes: vec![1],
            ..CommitBatch::default()
        };
        assert!(store.commit(&both).is_err());
        let smuggled = CommitBatch {
            puts: vec![("items".to_string(), "[]".to_string())],
            ..CommitBatch::default()
        };
        assert!(store.commit(&smuggled).is_err());
        assert_eq!(snapshot(&store), before);
    }

    /// 直接写一行旧布局（0.1.20 及以前：`items` 一行存整个数组）。
    fn write_legacy_items(db: &TempDb, json: &str) {
        let conn = Connection::open(db.path()).expect("打开");
        conn.execute(
            "INSERT INTO kv (k, v) VALUES ('items', ?1)",
            params![encrypt(&TEST_KEY, LEGACY_ITEMS_KEY, json).expect("加密")],
        )
        .expect("写旧布局");
    }

    #[test]
    fn legacy_items_row_is_migrated_atomically() {
        let db = TempDb::new("legacy");
        drop(db.open()); // 建表
        write_legacy_items(&db, r#"[{"id":2,"title":"b"},{"id":1,"title":"a"}]"#);

        let store = db.open();
        let items = store.load_items().expect("读并迁移");
        assert_eq!(items, vec![r#"{"id":1,"title":"a"}"#, r#"{"id":2,"title":"b"}"#]);
        // 旧行已删除，新行已就位；再读一次结果不变（迁移幂等）。
        assert_eq!(store.get(LEGACY_ITEMS_KEY).expect("读"), None);
        assert_eq!(store.load_items().expect("再读"), items);
    }

    #[test]
    fn corrupt_legacy_items_are_left_untouched() {
        let db = TempDb::new("legacy-corrupt");
        drop(db.open());
        // 重复 id：迁移必须拒绝，并保留旧行原样，绝不写出一半。
        let legacy = r#"[{"id":1,"title":"a"},{"id":1,"title":"dup"}]"#;
        write_legacy_items(&db, legacy);

        let store = db.open();
        assert!(store.load_items().is_err());
        assert_eq!(store.get(LEGACY_ITEMS_KEY).expect("读").as_deref(), Some(legacy));
        let conn = store.conn.lock().expect("锁");
        let new_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM kv WHERE k LIKE 'item:%'", (), |row| row.get(0))
            .expect("数行");
        assert_eq!(new_rows, 0);
    }

    #[test]
    fn legacy_and_new_rows_together_refuse_to_guess() {
        let db = TempDb::new("legacy-both");
        {
            let store = db.open();
            store
                .commit(&CommitBatch {
                    item_upserts: vec![(1, item_json(1, "new"))],
                    ..CommitBatch::default()
                })
                .expect("写新布局");
        }
        write_legacy_items(&db, r#"[{"id":1,"title":"old"}]"#);
        let store = db.open();
        assert!(store.load_items().is_err(), "两种布局并存时不能替用户选一份");
        assert!(store.get(LEGACY_ITEMS_KEY).expect("读").is_some());
    }

    #[test]
    fn replace_items_also_drops_legacy_row() {
        let db = TempDb::new("legacy-replace");
        drop(db.open());
        write_legacy_items(&db, r#"[{"id":1,"title":"old"}]"#);
        let store = db.open();
        store.commit(&full_batch("new", &[5])).expect("整体替换");
        assert_eq!(store.get(LEGACY_ITEMS_KEY).expect("读"), None);
        assert_eq!(store.load_items().expect("读"), vec![item_json(5, "new")]);
    }

    #[test]
    fn item_key_parsing_is_canonical() {
        assert_eq!(parse_item_key("item:0"), Some(0));
        assert_eq!(parse_item_key("item:42"), Some(42));
        assert_eq!(parse_item_key("item:042"), None);
        assert_eq!(parse_item_key("item:+1"), None);
        assert_eq!(parse_item_key("item:"), None);
        assert_eq!(parse_item_key("items"), None);
    }

    #[test]
    fn missing_key_error_keeps_actionable_detail() {
        // 这条文案是用户唯一能自救的线索，不能被泛化成"存储失败"。
        let error = missing_key_policy(true).expect_err("已有数据时必须拒绝新建密钥");
        assert_eq!(error.code(), "missing_key");
        assert!(error.detail().contains("凭据管理器"));
        assert!(error.detail().contains("不会新建密钥"));
    }
}
