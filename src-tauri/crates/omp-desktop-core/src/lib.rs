//! Code shared by the OMP Desktop app and its persona service `omp-desktopd`.
pub mod approval;
pub mod child_path;
pub mod json_store;
pub mod persona_protocol;
pub mod proc_util;

#[cfg(test)]
mod test_support;
