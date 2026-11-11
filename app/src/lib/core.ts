import { invoke } from '@tauri-apps/api/core';

/** Mirrors `fhp_core::About`; generated from Rust once view models exist (T3). */
export type About = { version: string };

export function fetchAbout(): Promise<About> {
  return invoke<About>('about');
}
