use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn detail(
        code: impl Into<String>,
        message: impl Into<String>,
        detail: serde_json::Value,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: Some(detail),
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        Self::new("DB_ERROR", value.to_string())
    }
}

impl From<r2d2::Error> for AppError {
    fn from(value: r2d2::Error) -> Self {
        Self::new("DB_POOL_ERROR", value.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::new("IO_ERROR", value.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
