use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::{plugin::{PluginApi, PluginHandle}, AppHandle, Runtime};
use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<NativeStruct<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.readest.eink", "EinkPlugin")
        .map_err(|e| Error::PluginInvoke(e.to_string()))?;
    #[cfg(target_os = "ios")]
    tauri::ios_plugin_binding!(init_plugin_eink);
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_eink)
        .map_err(|e| Error::PluginInvoke(e.to_string()))?;
    Ok(NativeStruct(handle))
}

pub struct NativeStruct<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> NativeStruct<R> {
    pub fn get_capabilities(&self) -> Result<EpdCapabilities> {
        let result: EpdCapabilities = self.0.run_mobile_plugin("get_epd_capabilities", ())
            .map_err(|e| Error::PluginInvoke(e.to_string()))?;
        Ok(result)
    }
    pub fn set_mode(&self, mode: &str) -> Result<()> {
        #[derive(Serialize)]
        struct Payload<'a> { mode: &'a str }
        self.0.run_mobile_plugin::<()>("set_epd_mode", Payload { mode })
            .map_err(|e| Error::PluginInvoke(e.to_string()))?;
        Ok(())
    }
    pub fn do_full_refresh(&self) -> Result<()> {
        self.0.run_mobile_plugin::<()>("do_epd_refresh", ())
            .map_err(|e| Error::PluginInvoke(e.to_string()))?;
        Ok(())
    }
}
