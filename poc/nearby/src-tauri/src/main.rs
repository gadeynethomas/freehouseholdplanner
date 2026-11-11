// Desktop entry point; on Android the library's mobile entry point is used.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fhp_nearby_lib::run();
}
