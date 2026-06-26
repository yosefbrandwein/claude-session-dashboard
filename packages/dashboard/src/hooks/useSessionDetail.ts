import { useEffect, useState } from 'react';
import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
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
): {
  messages: MessageRow[];
  permissions: PermissionRow[];
  loaded: boolean;
  sendMessage: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  decide: (reqId: string, approve: boolean) => Promise<void>;
} {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!uid || !sessionId) {
      setMessages([]);
      setPermissions([]);
      setLoaded(false);
      return;
    }
    setLoaded(false);

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
    });

    return () => {
      unsubMsgs();
      unsubPerms();
    };
  }, [uid, sessionId]);

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
      // createdAt is a number in the contract; serverTimestamp keeps clocks
      // honest. The agent reads it as a Firestore Timestamp / millis.
      createdAt: serverTimestamp(),
    };
    await addDoc(collection(db, paths.commands(uid)), cmd);
  };

  return {
    messages,
    permissions,
    loaded,
    sendMessage: (text: string) => writeCommand('sendMessage', { text }),
    interrupt: () => writeCommand('interrupt'),
    decide: (reqId: string, approve: boolean) =>
      writeCommand(approve ? 'approve' : 'deny', { reqId }),
  };
}
