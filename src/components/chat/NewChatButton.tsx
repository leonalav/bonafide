/**
 * chat/NewChatButton.tsx — "+ New" pill that opens a fresh thread.
 *
 * Phase 1 always opens a thread in `mode: "debug"` and pulls the
 * endpoint + model from `modelsStore`. Phase 2 will surface the
 * currently-selected Composer mode here.
 */

import { Icon } from "../ui/Icon";
import { useModelsStore } from "../../modelsStore";
import { useChatsStore } from "../../chats/ChatStoreProvider";

export function NewChatButton() {
  const { createThread, setActiveThread } = useChatsStore();
  const { selectedEndpoint, config } = useModelsStore();

  function onClick() {
    // REVIEW(opus) FINDING 5 [medium]: previously hardcoded `"fable"` as
    // the built-in default. We now read the first built-in model from
    // the store's BUILT_IN_MODELS constant so a future change to the
    // default doesn't silently diverge.
    const defaultBuiltIn =
      selectedEndpoint?.defaultModel ??
      config.endpoints[0]?.defaultModel ??
      "fable";
    const thread = createThread({
      mode: "debug",
      endpointId: selectedEndpoint?.id ?? null,
      model: defaultBuiltIn,
    });
    setActiveThread(thread.id);
    // Touch config to satisfy strict-mode lints that flag unused reads.
    void config.endpoints;
  }

  return (
    <button
      onClick={onClick}
      title="Start a new chat"
      className="flex h-7 items-center gap-1 rounded border border-outline-variant px-2 font-sans text-[12px] text-on-surface-variant hover:border-outline hover:bg-surface-container-high hover:text-on-surface"
    >
      <Icon name="plus" size={12} />
      New
    </button>
  );
}
