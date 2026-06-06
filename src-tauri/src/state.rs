use std::collections::{HashMap, VecDeque};
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use std::time::{Duration, SystemTime};

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde_json::Value;

use crate::paths::AppPaths;

pub struct StoredPlan {
    pub plan: Value,
    pub expires_at: SystemTime,
}

#[derive(Clone)]
pub struct AiJob {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub result: Option<Value>,
    pub error: Option<Value>,
}

pub struct AppState {
    pub paths: AppPaths,
    pub db: Pool<SqliteConnectionManager>,
    pub last_scan: Mutex<Option<Value>>,
    pub plan_store: Mutex<HashMap<String, StoredPlan>>,
    pub sync_lock: Mutex<()>,
    pub ai_queue: Arc<Mutex<VecDeque<String>>>,
    pub ai_worker_running: Arc<AtomicBool>,
    pub ai_jobs: Arc<Mutex<HashMap<String, AiJob>>>,
}

impl AppState {
    pub fn evict_expired_plans(&self) {
        let now = SystemTime::now();
        if let Ok(mut plans) = self.plan_store.lock() {
            plans.retain(|_, p| p.expires_at > now);
            if plans.len() > 50 {
                let drop_count = plans.len() - 50;
                let keys: Vec<String> = plans.keys().take(drop_count).cloned().collect();
                for key in keys {
                    plans.remove(&key);
                }
            }
        }
    }

    pub fn plan_ttl() -> Duration {
        Duration::from_secs(5 * 60)
    }
}
