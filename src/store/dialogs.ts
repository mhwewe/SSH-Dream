// store/dialogs.ts — promise-based modal dialogs (WebView2 has no usable window.prompt/confirm).
//   const name = await dialogs.prompt("Name", "default");   // string | null
//   const pick = await dialogs.choose("Title", "text", ["Save", "Discard", "Cancel"]); // button label
// Rendered by components/Dialogs.tsx.
import { create } from "zustand";

export type DialogReq =
  | { kind: "prompt"; title: string; initial: string; resolve: (v: string | null) => void }
  | { kind: "choose"; title: string; text: string; buttons: string[]; resolve: (v: string) => void };

export const useDialogs = create<{ current: DialogReq | null }>(() => ({ current: null }));

export const dialogs = {
  prompt(title: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => {
      useDialogs.setState({
        current: { kind: "prompt", title, initial, resolve: (v) => { useDialogs.setState({ current: null }); resolve(v); } },
      });
    });
  },
  choose(title: string, text: string, buttons: string[]): Promise<string> {
    return new Promise((resolve) => {
      useDialogs.setState({
        current: { kind: "choose", title, text, buttons, resolve: (v) => { useDialogs.setState({ current: null }); resolve(v); } },
      });
    });
  },
};
