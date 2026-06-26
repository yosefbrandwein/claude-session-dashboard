import type { SessionStatus } from '../../../../shared/src/types';
import { STATUS_LABEL } from '../model';

/** Color-coded status pill. `needs-attention` pulses via CSS. */
export function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span className={`pill ${status}`}>
      <span className="led" />
      {STATUS_LABEL[status]}
    </span>
  );
}
