// KeyboardEvent.code -> [Windows set-1 scan code (0x100 = extended), X11 keysym name].
const t = {};
const row = (codes, scan, x) => codes.forEach((c, i) => { t[c] = [scan + i, x[i]]; });
const fkeys = Array.from({ length: 10 }, (_, i) => `F${i + 1}`);
row([...'1234567890'].map(d => `Digit${d}`), 0x02, [...'1234567890']);
row([...'QWERTYUIOP'].map(d => `Key${d}`), 0x10, [...'qwertyuiop']);
row([...'ASDFGHJKL'].map(d => `Key${d}`), 0x1e, [...'asdfghjkl']);
row([...'ZXCVBNM'].map(d => `Key${d}`), 0x2c, [...'zxcvbnm']);
row(fkeys, 0x3b, fkeys);
Object.assign(t, {
  F11: [0x57, 'F11'], F12: [0x58, 'F12'], Escape: [0x01, 'Escape'], Minus: [0x0c, 'minus'], Equal: [0x0d, 'equal'], Backspace: [0x0e, 'BackSpace'], Tab: [0x0f, 'Tab'],
  BracketLeft: [0x1a, 'bracketleft'], BracketRight: [0x1b, 'bracketright'], Enter: [0x1c, 'Return'], ControlLeft: [0x1d, 'Control_L'], Semicolon: [0x27, 'semicolon'], Quote: [0x28, 'apostrophe'],
  Backquote: [0x29, 'grave'], ShiftLeft: [0x2a, 'Shift_L'], Backslash: [0x2b, 'backslash'], Comma: [0x33, 'comma'], Period: [0x34, 'period'], Slash: [0x35, 'slash'], ShiftRight: [0x36, 'Shift_R'],
  NumpadMultiply: [0x37, 'KP_Multiply'], AltLeft: [0x38, 'Alt_L'], Space: [0x39, 'space'], CapsLock: [0x3a, 'Caps_Lock'], NumLock: [0x45, 'Num_Lock'], ScrollLock: [0x46, 'Scroll_Lock'],
  Numpad7: [0x47, 'KP_7'], Numpad8: [0x48, 'KP_8'], Numpad9: [0x49, 'KP_9'], NumpadSubtract: [0x4a, 'KP_Subtract'], Numpad4: [0x4b, 'KP_4'], Numpad5: [0x4c, 'KP_5'], Numpad6: [0x4d, 'KP_6'],
  NumpadAdd: [0x4e, 'KP_Add'], Numpad1: [0x4f, 'KP_1'], Numpad2: [0x50, 'KP_2'], Numpad3: [0x51, 'KP_3'], Numpad0: [0x52, 'KP_0'], NumpadDecimal: [0x53, 'KP_Decimal'], IntlBackslash: [0x56, 'less'],
  NumpadEnter: [0x11c, 'KP_Enter'], ControlRight: [0x11d, 'Control_R'], NumpadDivide: [0x135, 'KP_Divide'], PrintScreen: [0x137, 'Print'], AltRight: [0x138, 'Alt_R'], Home: [0x147, 'Home'], ArrowUp: [0x148, 'Up'], PageUp: [0x149, 'Prior'],
  ArrowLeft: [0x14b, 'Left'], ArrowRight: [0x14d, 'Right'], End: [0x14f, 'End'], ArrowDown: [0x150, 'Down'], PageDown: [0x151, 'Next'], Insert: [0x152, 'Insert'], Delete: [0x153, 'Delete'],
  MetaLeft: [0x15b, 'Super_L'], MetaRight: [0x15c, 'Super_R'], ContextMenu: [0x15d, 'Menu'],
});
export default t;
