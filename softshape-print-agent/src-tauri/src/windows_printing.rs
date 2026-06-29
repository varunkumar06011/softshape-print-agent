/// Windows raw printing via Win32 API (Winspool)
///
/// Uses RawDocToPrinter to send ESC/POS bytes directly to the printer
/// without showing a print dialog.

use std::ptr::null_mut;

use windows::core::{PCSTR, PSTR};
use windows::Win32::Foundation::{BOOL, HANDLE};
use windows::Win32::Graphics::Printing::{
    ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterA, StartDocPrinterA,
    StartPagePrinter, WritePrinter, DOC_INFO_1A, PRINTER_INFO_1A, EnumPrintersA,
    PRINTER_ENUM_LOCAL, PRINTER_ENUM_CONNECTIONS, GetDefaultPrinterA,
};

/// Convert a Rust string to a null-terminated ANSI string (for OpenPrinterA etc.)
fn to_ansi(s: &str) -> Vec<u8> {
    s.bytes().chain(std::iter::once(0)).collect()
}

/// Enumerate all installed printers on this machine.
pub fn enumerate_printers() -> Result<Vec<super::PrinterInfo>, String> {
    // Get the default printer name first
    let default_printer_name = {
        let mut size: u32 = 0;
        let _ = unsafe { GetDefaultPrinterA(PSTR::null(), &mut size) };
        let mut buf = vec![0u8; size as usize];
        let ok = unsafe { GetDefaultPrinterA(PSTR::from_raw(buf.as_mut_ptr()), &mut size) };
        if ok.is_ok() && size > 1 {
            let cstr = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr() as *const i8) };
            cstr.to_string_lossy().to_string()
        } else {
            String::new()
        }
    };

    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed: u32 = 0;
    let mut returned: u32 = 0;

    // First call to get buffer size
    let _ = unsafe {
        EnumPrintersA(
            flags,
            None,
            1,
            None,
            &mut needed,
            &mut returned,
        )
    };

    if needed == 0 {
        return Ok(vec![]);
    }

    let mut buffer = vec![0u8; needed as usize];

    let result = unsafe {
        EnumPrintersA(
            flags,
            None,
            1,
            Some(&mut buffer),
            &mut needed,
            &mut returned,
        )
    };

    if result.is_err() {
        return Err("EnumPrintersA failed".to_string());
    }

    // Parse PRINTER_INFO_1A array from the buffer
    let mut printers = Vec::new();
    let struct_size = std::mem::size_of::<PRINTER_INFO_1A>();
    let count = returned as usize;

    for i in 0..count {
        let offset = i * struct_size;
        if offset + struct_size > buffer.len() {
            break;
        }

        let info: &PRINTER_INFO_1A = unsafe {
            &*(buffer.as_ptr().add(offset) as *const PRINTER_INFO_1A)
        };

        // Extract printer name from the PCSTR pointer
        let name_pcstr = info.pName;
        if !name_pcstr.is_null() {
            let name_cstr = unsafe { std::ffi::CStr::from_ptr(name_pcstr.as_ptr() as *const i8) };
            let name = name_cstr.to_string_lossy().to_string();
            let is_default = !default_printer_name.is_empty() && name == default_printer_name;
            printers.push(super::PrinterInfo {
                name,
                is_default,
            });
        }
    }

    Ok(printers)
}

/// Send raw bytes to a printer by name. No print dialog.
pub fn raw_print(printer_name: &str, bytes: &[u8]) -> Result<(), String> {
    let name_ansi = to_ansi(printer_name);
    let mut handle = HANDLE(0);

    // Open the printer
    let result = unsafe {
        OpenPrinterA(
            PCSTR::from_raw(name_ansi.as_ptr()),
            &mut handle as *mut _,
            None,
        )
    };

    if result.is_err() {
        return Err(format!("Cannot open printer: {}", printer_name));
    }

    // Start a raw document — DOC_INFO_1A uses PSTR (mutable pointers)
    let mut doc_name = to_ansi("SoftShape Print Job");
    let mut raw_type = to_ansi("RAW");
    let doc_info = DOC_INFO_1A {
        pDocName: PSTR::from_raw(doc_name.as_mut_ptr()),
        pOutputFile: PSTR::null(),
        pDatatype: PSTR::from_raw(raw_type.as_mut_ptr()),
    };

    let job_id = unsafe { StartDocPrinterA(handle, 1, &doc_info) };
    if job_id == 0 {
        unsafe { ClosePrinter(handle) };
        return Err("StartDocPrinter failed".to_string());
    }

    // Start a page
    let page_result = unsafe { StartPagePrinter(handle) };
    if !page_result.as_bool() {
        unsafe {
            EndDocPrinter(handle);
            ClosePrinter(handle);
        }
        return Err("StartPagePrinter failed".to_string());
    }

    // Write the raw bytes
    let mut written: u32 = 0;
    let write_result = unsafe {
        WritePrinter(
            handle,
            bytes.as_ptr() as *const _,
            bytes.len() as u32,
            &mut written,
        )
    };

    // End page and document
    unsafe {
        EndPagePrinter(handle);
        EndDocPrinter(handle);
        ClosePrinter(handle);
    }

    if !write_result.as_bool() {
        return Err(format!(
            "WritePrinter failed (wrote {} of {} bytes)",
            written,
            bytes.len()
        ));
    }

    Ok(())
}
