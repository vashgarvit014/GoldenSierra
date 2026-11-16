/**
 * One colour family per job/document state, so a failure never reads like a
 * success: queued is neutral, running is blue, completed is green, failed red.
 */
export function statusClass(status: string): string {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
    case 'INDEXED':
    case 'ACTIVE':
      return 'status done';
    case 'RUNNING':
    case 'PROCESSING':
      return 'status running';
    case 'FAILED':
      return 'status failed';
    case 'CANCELLED':
    case 'ARCHIVED':
      return 'status gray';
    default:
      return 'status queued';
  }
}
