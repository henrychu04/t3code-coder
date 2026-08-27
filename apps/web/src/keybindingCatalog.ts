import {
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type KeybindingCommand,
} from "@t3tools/contracts";

export interface KeybindingActionDefinition {
  readonly command: KeybindingCommand;
  readonly label: string;
  readonly category: "Files" | "Navigation" | "Panels" | "Chat" | "Terminal" | "Scripts";
}

export const KEYBINDING_ACTIONS: ReadonlyArray<KeybindingActionDefinition> = [
  { command: "fileViewer.find", label: "Find in current file", category: "Files" },
  { command: "projectSearch.toggle", label: "Find text in project", category: "Files" },
  { command: "filePicker.toggle", label: "Search project files", category: "Files" },
  { command: "fileViewer.goToLine", label: "Go to line and column", category: "Files" },
  { command: "commandPalette.toggle", label: "Find action", category: "Navigation" },
  { command: "thread.previous", label: "Previous thread", category: "Navigation" },
  { command: "thread.next", label: "Next thread", category: "Navigation" },
  { command: "thread.settle", label: "Settle or un-settle current thread", category: "Chat" },
  ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    command,
    label: `Go to thread ${index + 1}`,
    category: "Navigation" as const,
  })),
  { command: "sidebar.toggle", label: "Toggle sidebar", category: "Panels" },
  { command: "rightPanel.toggle", label: "Toggle right panel", category: "Panels" },
  {
    command: "rightPanel.toggleMaximized",
    label: "Maximize right panel",
    category: "Panels",
  },
  { command: "diff.toggle", label: "Toggle diff", category: "Panels" },
  { command: "chat.new", label: "New thread", category: "Chat" },
  { command: "chat.newLocal", label: "New thread in current project", category: "Chat" },
  { command: "composer.stash", label: "Stash composer draft", category: "Chat" },
  { command: "modelPicker.toggle", label: "Open model picker", category: "Chat" },
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    command,
    label: `Choose model ${index + 1}`,
    category: "Chat" as const,
  })),
  { command: "terminal.toggle", label: "Toggle terminal", category: "Terminal" },
  { command: "terminal.new", label: "New terminal", category: "Terminal" },
  { command: "terminal.close", label: "Close terminal", category: "Terminal" },
  { command: "terminal.split", label: "Split terminal", category: "Terminal" },
  {
    command: "terminal.splitVertical",
    label: "Split terminal vertically",
    category: "Terminal",
  },
];
