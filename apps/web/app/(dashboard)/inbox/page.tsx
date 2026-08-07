export const dynamic = "force-dynamic";

/**
 * `/inbox` is a routing sink. The persistent chat host mounted in the
 * dashboard layout owns the Slack-style workspace (and its `?agent=`
 * deep-link handling), so this page renders nothing — exactly how
 * Hermes keeps its ChatPage alive outside the routed tree.
 */
export default function InboxPage() {
  return null;
}
