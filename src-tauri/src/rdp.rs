// =============================================================================
// rdp.rs — launches Windows' built-in mstsc.exe with a generated .rdp file.
// Called by: commands/rdp.rs.  Calls: profiles.rs (load), secrets.rs (get), logging.rs.
//
// Credentials flow (only when rdp.storePassword is true AND a secret exists):
//   1. CredWriteW creates a temporary *generic* credential "TERMSRV/<host>" (session-persisted),
//      which mstsc picks up so it does not prompt. Password never touches a command line.
//   2. ~CLEANUP_DELAY_SECS later a background task deletes the credential and the temp .rdp.
// TEST ON A REAL MACHINE: if mstsc reads the credential later than the delay, raise it.
// Removal uses `cmdkey /delete:<target>` (no secret in the arguments), which avoids depending
// on the exact CredDeleteW signature of the pinned `windows` crate version.
// =============================================================================
use crate::error::{AppError, AppResult};
use crate::logging::{emit_log, LogLevel};
use tauri::AppHandle;

/// Seconds before the temp .rdp file and the temporary credential are removed.
#[allow(dead_code)]
const CLEANUP_DELAY_SECS: u64 = 20;

/// Smallest / largest width or height mstsc accepts for `desktopwidth` / `desktopheight`.
const MIN_DIM: u32 = 200;
const MAX_DIM: u32 = 8192;

/// Parses the "Resolution" text box: "1920x1080" (also "1920 x 1080", "1920*1080", "1920×1080", "1920,1080").
/// Blank => `Ok(None)` (let mstsc choose). Used by profiles.rs to reject bad input when saving, and by `launch`.
#[allow(dead_code)]
pub fn parse_resolution(text: &str) -> Result<Option<(u32, u32)>, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let bad = || format!("Resolution must look like 1920x1080 (each side {MIN_DIM}-{MAX_DIM})");
    let mut parts = t.split(|c: char| matches!(c, 'x' | 'X' | '*' | '×' | ',')).map(str::trim);
    let (w, h) = match (parts.next(), parts.next(), parts.next()) {
        (Some(w), Some(h), None) => (w, h),
        _ => return Err(bad()),
    };
    let (w, h): (u32, u32) = match (w.parse(), h.parse()) {
        (Ok(w), Ok(h)) => (w, h),
        _ => return Err(bad()),
    };
    if !(MIN_DIM..=MAX_DIM).contains(&w) || !(MIN_DIM..=MAX_DIM).contains(&h) {
        return Err(bad());
    }
    Ok(Some((w, h)))
}

/// Pure function: builds the .rdp file text (one setting per line, CRLF). No password in here.
///
/// * `resolution`   — Some((w,h)) sets the size the session (and, windowed, the mstsc window) starts with.
/// * `smart_resize` — true  => `dynamic resolution:i:1`: when the mstsc window is resized, the REMOTE desktop is
///                             resized to match (RDP "display control"; needs a Windows 8.1 / Server 2012 R2+ host).
///                    false => fixed session size (scrollbars appear when the window is smaller).
///   `smart sizing:i:0` is always written: "smart sizing" would SCALE the picture instead of resizing the session.
#[allow(dead_code)]
fn build_rdp_text(
    host: &str,
    port: u16,
    username: &str,
    fullscreen: bool,
    resolution: Option<(u32, u32)>,
    smart_resize: bool,
) -> String {
    let mut s = String::new();
    s.push_str(&format!("full address:s:{host}\r\n"));
    s.push_str(&format!("server port:i:{port}\r\n"));
    if !username.is_empty() {
        s.push_str(&format!("username:s:{username}\r\n"));
    }
    s.push_str(&format!("screen mode id:i:{}\r\n", if fullscreen { 2 } else { 1 }));
    s.push_str("use multimon:i:0\r\n");
    if let Some((w, h)) = resolution {
        s.push_str(&format!("desktopwidth:i:{w}\r\n"));
        s.push_str(&format!("desktopheight:i:{h}\r\n"));
    }
    s.push_str("smart sizing:i:0\r\n");
    s.push_str(&format!("dynamic resolution:i:{}\r\n", if smart_resize { 1 } else { 0 }));
    s.push_str("prompt for credentials:i:0\r\n");
    s
}

#[cfg(not(windows))]
pub async fn launch(_app: &AppHandle, _profile_id: &str) -> AppResult<()> {
    Err(AppError::invalid("RDP launcher is Windows-only"))
}

#[cfg(windows)]
pub async fn launch(app: &AppHandle, profile_id: &str) -> AppResult<()> {
    use crate::{profiles, secrets};
    use std::time::Duration;
    use uuid::Uuid;

    let p = profiles::get(app, profile_id)?;

    // Resolve host/username: blank RDP value means "same as SSH".
    let host = p.rdp.host.clone().filter(|h| !h.trim().is_empty()).unwrap_or_else(|| p.ssh.host.clone());
    let host = host.trim().to_string();
    let username = p.rdp.username.clone().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| p.ssh.username.clone());
    let username = username.trim().to_string();
    if host.is_empty() {
        return Err(AppError::invalid("No host set (fill the RDP host or the SSH host)"));
    }
    // Security: a newline in these values would inject extra settings into the .rdp file.
    if host.contains(['\r', '\n']) || username.contains(['\r', '\n']) {
        return Err(AppError::invalid("Host/username must not contain line breaks"));
    }

    // Resolution text box ("" = let mstsc decide). Validated again here because the profile file can be edited by hand.
    let resolution = parse_resolution(p.rdp.resolution.as_deref().unwrap_or("")).map_err(AppError::invalid)?;

    // 1. temp .rdp file
    let rdp_path = std::env::temp_dir().join(format!("{}.rdp", Uuid::new_v4()));
    std::fs::write(
        &rdp_path,
        build_rdp_text(&host, p.rdp.port, &username, p.rdp.fullscreen, resolution, p.rdp.smart_resize),
    )?;

    // 2. optional temporary credential
    let target = format!("TERMSRV/{host}");
    let mut wrote_cred = false;
    if p.rdp.store_password {
        if let Some(pw) = secrets::get(profile_id, "rdp")? {
            if !pw.is_empty() {
                wincred::write(&target, &username, &pw)
                    .map_err(|e| AppError::new("secret_store", format!("Could not register RDP credential: {e}")))?;
                wrote_cred = true;
            }
        }
    }

    // 3. start mstsc (do not wait for it)
    if let Err(e) = std::process::Command::new("mstsc.exe").arg(&rdp_path).spawn() {
        let _ = std::fs::remove_file(&rdp_path);
        if wrote_cred { wincred::delete(&target); }
        return Err(AppError::io(format!("Could not start mstsc.exe: {e}")));
    }
    let size = resolution.map(|(w, h)| format!("{w}x{h}")).unwrap_or_else(|| "default size".into());
    emit_log(
        app, None, LogLevel::Info,
        format!("Launching Remote Desktop to {}:{} ({size}, smart resize {})", host, p.rdp.port, if p.rdp.smart_resize { "on" } else { "off" }),
    );

    // 4. delayed cleanup (credential + temp file)
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(CLEANUP_DELAY_SECS)).await;
        let _ = std::fs::remove_file(&rdp_path);
        if wrote_cred { wincred::delete(&target); }
    });
    Ok(())
}

/// Windows Credential Manager helpers (Windows only).
#[cfg(windows)]
mod wincred {
    use std::os::windows::process::CommandExt;
    use windows::core::PWSTR;
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_SESSION, CRED_TYPE_GENERIC,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect() // NUL-terminated UTF-16
    }

    /// Create/overwrite a generic credential `target` (user + password), session-persisted.
    pub fn write(target: &str, user: &str, password: &str) -> Result<(), String> {
        let mut target_w = wide(target);
        let mut user_w = wide(user);
        // The credential blob is the password as UTF-16 bytes WITHOUT a terminating NUL
        // (same format cmdkey produces).
        let mut blob: Vec<u8> = password.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target_w.as_mut_ptr()),
            UserName: PWSTR(user_w.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_SESSION,
            ..Default::default()
        };
        // SAFETY: all pointers point into vectors that outlive this call.
        let res = unsafe { CredWriteW(&cred, 0) }.map_err(|e| e.to_string());
        blob.iter_mut().for_each(|b| *b = 0); // wipe the plaintext copy
        res
    }

    /// Best-effort delete. Hidden window; no secret in the arguments.
    pub fn delete(target: &str) {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("cmdkey")
            .arg(format!("/delete:{target}"))
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_accepts_common_spellings() {
        assert_eq!(parse_resolution(""), Ok(None));
        assert_eq!(parse_resolution("1920x1080"), Ok(Some((1920, 1080))));
        assert_eq!(parse_resolution(" 1920 X 1080 "), Ok(Some((1920, 1080))));
        assert_eq!(parse_resolution("1366×768"), Ok(Some((1366, 768))));
        assert_eq!(parse_resolution("800,600"), Ok(Some((800, 600))));
    }

    #[test]
    fn resolution_rejects_garbage_and_out_of_range() {
        for bad in ["1920", "x1080", "axb", "1920x1080x32", "199x600", "9000x600", "-5x600", "1920 1080"] {
            assert!(parse_resolution(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rdp_text_has_resize_and_size_settings() {
        let t = build_rdp_text("h", 3389, "u", false, Some((1600, 900)), true);
        assert!(t.contains("desktopwidth:i:1600\r\n") && t.contains("desktopheight:i:900\r\n"));
        assert!(t.contains("dynamic resolution:i:1\r\n") && t.contains("smart sizing:i:0\r\n"));
        let t = build_rdp_text("h", 3389, "", true, None, false);
        assert!(!t.contains("desktopwidth") && t.contains("dynamic resolution:i:0\r\n") && t.contains("screen mode id:i:2\r\n"));
    }
}
