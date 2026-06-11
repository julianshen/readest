use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeStruct<R>> {
    Ok(NativeStruct(PhantomData))
}

// Desktop has no EPD hardware; generic over R to mirror mobile::NativeStruct
// so lib.rs can name NativeStruct<R> on every platform. `fn() -> R` keeps
// the marker Send + Sync (app.manage requires it) without bounding R.
pub struct NativeStruct<R: Runtime>(PhantomData<fn() -> R>);

impl<R: Runtime> NativeStruct<R> {
    pub fn get_capabilities(&self) -> Result<EpdCapabilities> {
        Ok(EpdCapabilities {
            available: false,
            modes: vec![],
        })
    }
    pub fn set_mode(&self, _mode: &str) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
    pub fn do_full_refresh(&self) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
}
