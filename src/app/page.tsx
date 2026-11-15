import { Session } from '@/components/counselor/Session';
import './counselor.css';

export const dynamic = 'force-dynamic';

/**
 * The public experience is counselor mode: understand first, recommend last.
 * The earlier direct-answer chat is still available at /chat.
 */
export default function HomePage() {
  return <Session />;
}
