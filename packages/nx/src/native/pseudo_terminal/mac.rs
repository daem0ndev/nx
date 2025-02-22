use std::collections::HashMap;

use tracing::trace;

use nx_logger::enable_logger;
use nx_pty::pseudo_terminal::child_process::ChildProcess;
use nx_pty::pseudo_terminal::{create_pseudo_terminal, os, run_command};



pub struct RustPseudoTerminal {}

impl RustPseudoTerminal {
    pub fn new() -> napi::Result<Self> {
        enable_logger();
        Ok(Self {})
    }

    pub fn run_command(
        &self,
        command: String,
        command_dir: Option<String>,
        js_env: Option<HashMap<String, String>>,
        exec_argv: Option<Vec<String>>,
        quiet: Option<bool>,
        tty: Option<bool>,
    ) -> napi::Result<ChildProcess> {
        let pseudo_terminal = create_pseudo_terminal()?;
        run_command(
            &pseudo_terminal,
            command,
            command_dir,
            js_env,
            exec_argv,
            quiet,
            tty,
        )
    }

    /// This allows us to run a pseudoterminal with a fake node ipc channel
    /// this makes it possible to be backwards compatible with the old implementation
    #[allow(clippy::too_many_arguments)]
    pub fn fork(
        &self,
        id: String,
        fork_script: String,
        pseudo_ipc_path: String,
        command_dir: Option<String>,
        js_env: Option<HashMap<String, String>>,
        exec_argv: Option<Vec<String>>,
        quiet: bool,
    ) -> napi::Result<ChildProcess> {
        let command = format!(
            "node {} {} {}",
            os::handle_path_space(fork_script),
            pseudo_ipc_path,
            id
        );

        trace!("nx_fork command: {}", &command);
        self.run_command(
            command,
            command_dir,
            js_env,
            exec_argv,
            Some(quiet),
            Some(true),
        )
    }
}
