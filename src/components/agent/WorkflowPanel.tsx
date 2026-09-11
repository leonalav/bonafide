import { useState } from "react"

import { useWorkspaceRoot } from "../../ide/hooks"

import { WorkflowInbox } from "./WorkflowInbox"

import { ThreadDetail } from "./ThreadDetail"

import { type Thread } from "../../data/agents"

import { useThreads } from "../../data/threads"

export function WorkflowPanel() {
  const [open, setOpen] = useState<Thread | null>(null)
  const workspaceRoot = useWorkspaceRoot()
  const { threads } = useThreads(workspaceRoot)

  return (
    <div className="flex h-full w-full flex-col">
      {open ? (
        <ThreadDetail
          thread={open}
          threads={threads}
          onBack={() => setOpen(null)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4">
            <WorkflowInbox threads={threads} onOpen={setOpen} />
          </div>
        </div>
      )}
    </div>
  )
}
