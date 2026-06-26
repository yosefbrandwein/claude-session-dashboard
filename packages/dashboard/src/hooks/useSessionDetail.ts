import { useEffect, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';
import { paths } from '../../../../shared/src/types';
import type {
  CommandDoc,
  CommandType,
  MessageDoc,
  PermissionRequestDoc,
} from '../../../../shared/src/types';

export interface MessageRow extends MessageDoc {
  id: string;
}
export interface PermissionRow extends PermissionRequestDoc {
  id: string;
}
export interface CommandRow extends CommandDoc {
  id: string;
}

/**
 * Live message metadata + permission-request log for one session, plus the
 * command-writing helpers the detail drawer uses to control the agent.
 *
 * All control actions write a `CommandDoc` into `users/{uid}/commands`, exactly
 * matching the shared contract + the create rule in firestore.rules
 * (type ∈ {sendMessage,interrupt,approve,deny}, status:'pending').
 */
export function useSessionDetail(
  uid: string | null,
  sessionId: string | null,
  /** Called once per command when it reaches a terminal state, for toasts. */
  onCommandResult?: (status: 'done' | 'error', result: string) => void,
): {
  messages: MessageRow[];
  permissions: PermissionRow[];
  loaded: boolean;
  permsLoaded: boolean;
  /** Live commands for THIS session (pending/acked/done/error). */
  commands: CommandRow[];
  /** True while any command for this session is still pending or acked. */
  commandInFlight: boolean;
  sendMessage: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  decide: (reqId: string, approve: boolean) => Promise<void>;
} {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [commands, setCommands] = useState<CommandRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [permsLoaded, setPermsLoaded] = useState(false);

  // Latest onCommandResult kept in a ref so the snapshot effect doesn't need it
  // in its dependency array (which would re-subscribe on every parent render).
  const onResultRef = useRef(onCommandResult);
  onResultRef.current = onCommandResult;
  // Command ids we've already surfaced + cleaned up, so a duplicate snapshot
  // (or the brief window before deleteDoc lands) won't toast/delete twice.
  const surfacedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!uid || !sessionId) {
      setMessages([]);
      setPermissions([]);
      setCommands([]);
      setLoaded(false);
      setPermsLoaded(false);
      return;
    }
    setLoaded(false);
    setPermsLoaded(false);
    setCommands([]);
    surfacedRef.current = new Set();

    const msgsRef = query(
      collection(db, paths.messages(uid, sessionId)),
      orderBy('ts', 'asc'),
    );
    const unsubMsgs = onSnapshot(msgsRef, (snap) => {
      setMessages(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as MessageDoc) })),
      );
      setLoaded(true);
    });

    const permsRef = query(
      collection(db, paths.permissionRequests(uid, sessionId)),
      orderBy('ts', 'desc'),
    );
    const unsubPerms = onSnapshot(permsRef, (snap) => {
      setPermissions(
        snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as PermissionRequestDoc),
        })),
      );
      setPermsLoaded(true);
    });

    // Commands live in a per-USER collection; scope to this session so the
    // drawer only reacts to its own sends. The agent flips status
    // pending → acked → done|error and writes a `result` string (commands.ts).
    const cmdsRef = query(
      collection(db, paths.commands(uid)),
      where('sessionId', '==', sessionId),
    );
    const unsubCmds = onSnapshot(cmdsRef, (snap) => {
      const rows = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as CommandDoc),
      }));
      setCommands(rows);
      // Surface terminal commands exactly once: toast the result, then delete
      // the doc so the per-user commands collection doesn't accumulate.
      for (const c of rows) {
        if (
          (c.status === 'done' || c.status === 'error') &&
          !surfacedRef.current.has(c.id)
        ) {
          surfacedRef.current.add(c.id);
          onResultRef.current?.(c.status, c.result ?? '');
          void deleteDoc(doc(db, paths.commands(uid), c.id)).catch(() => {});
        }
      }
    });

    return () => {
      unsubMsgs();
      unsubPerms();
      unsubCmds();
    };
  }, [uid, sessionId]);

  const commandInFlight = commands.some(
    (c) => c.status === 'pending' || c.status === 'acked',
  );

  const writeCommand = async (
    type: CommandType,
    payload?: CommandDoc['payload'],
  ) => {
    if (!uid || !sessionId) return;
    const cmd = {
      type,
      sessionId,
      ...(payload ? { payload } : {}),
      status: 'pending' as const,
      // createdAt is declared as `number` in the shared contract. The agent's
      // command path doesn't orderBy/read it, so we write epoch-ms (Date.now())
      // to match the contract instead of a Firestore Timestamp.
      createdAt: Date.now(),
    };
    await addDoc(collection(db, paths.commands(uid)), cmd);
  };

  return {
    messages,
    permissions,
    loaded,
    permsLoaded,
    commands,
    commandInFlight,
    sendMessage: (text: string) => writeCommand('sendMessage', { text }),
    interrupt: () => writeCommand('interrupt'),
    decide: (reqId: string, approve: boolean) =>
      writeCommand(approve ? 'approve' : 'deny', { reqId }),
  };
}
