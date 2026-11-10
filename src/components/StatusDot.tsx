// StatusDot.tsx — coloured dot for a session state: grey=disconnected, amber=connecting,
// green=connected, red=error (colours in styles.css). Used by ProfileSwitcher.
import type { SessionState } from "../api/types";

export function StatusDot({ state }: { state: SessionState }) {
  return <span className={`dot dot-${state}`} title={state} />;
}
