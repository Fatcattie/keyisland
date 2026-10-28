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

    #[test]
    fn missing_key_error_keeps_actionable_detail() {
        // 这条文案是用户唯一能自救的线索，不能被泛化成"存储失败"。
        let error = missing_key_policy(true).expect_err("已有数据时必须拒绝新建密钥");
        assert_eq!(error.code(), "missing_key");
        assert!(error.detail().contains("凭据管理器"));
        assert!(error.detail().contains("不会新建密钥"));
    }
}
