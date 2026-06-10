use tauri::{plugin::{Builder, TauriPlugin}, Manager, Runtime};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;
mod commands;
mod error;
mod models;

pub use error::{Error, Result};

pub trait EinkExt<R: Runtime> {
    fn eink(&self) -> &NativeStruct<R>;
}

impl<R: Runtime, T: Manager<R>> EinkExt<R> for T {
    fn eink(&self) -> &NativeStruct<R> {
        self.state::<NativeStruct<R>>().inner()
    }
}

#[cfg(desktop)]
use desktop::NativeStruct;
#[cfg(mobile)]
use mobile::NativeStruct;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("eink")
        .invoke_handler(tauri::generate_handler![
            commands::get_epd_capabilities,
            commands::set_epd_mode,
            commands::do_epd_refresh,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let state = mobile::init(app, api)?;
            #[cfg(desktop)]
            let state = desktop::init(app, api)?;
            app.manage(state);
            Ok(())
        })
        .build()
}
