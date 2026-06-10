use tauri::{command, AppHandle, Runtime};
use crate::{EinkExt, models::*, error::Error};

#[command]
pub(crate) async fn get_epd_capabilities<R: Runtime>(
    app: AppHandle<R>,
) -> std::result::Result<EpdCapabilities, Error> {
    app.eink().get_capabilities()
}

#[command]
pub(crate) async fn set_epd_mode<R: Runtime>(
    app: AppHandle<R>,
    payload: SetEpdModeRequest,
) -> std::result::Result<(), Error> {
    app.eink().set_mode(&payload.mode)
}

#[command]
pub(crate) async fn do_epd_refresh<R: Runtime>(
    app: AppHandle<R>,
) -> std::result::Result<(), Error> {
    app.eink().do_full_refresh()
}
