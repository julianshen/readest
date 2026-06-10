use serde::de::DeserializeOwned;
use tauri::{plugin::{PluginApi, PluginHandle}, AppHandle, Runtime};
use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeStruct<R>> {
    Ok(NativeStruct)
}

pub struct NativeStruct;

impl NativeStruct {
    pub fn get_capabilities(&self) -> Result<EpdCapabilities> {
        Ok(EpdCapabilities { available: false, modes: vec![] })
    }
    pub fn set_mode(&self, _mode: &str) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
    pub fn do_full_refresh(&self) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
}
