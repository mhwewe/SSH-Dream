// StatusDot.tsx — coloured dot for a session state: grey=disconnected, amber (pulsing)=connecting,
// green=connected, red=error (colours in styles.css). Used by ProfileSwitcher and the Login tab.
// Has a text alternative for screen readers.
import type { SessionState } from "../api/types";

const LABEL: Record<SessionState, string> = { disconnected: "Disconnected", connecting: "Connecting", connected: "Connected", error: "Connection failed" };

export function StatusDot({ state }: { state: SessionState }) {
  return <span className={`dot dot-${state}`} title={LABEL[state]} role="img" aria-label={LABEL[state]} />;
}
