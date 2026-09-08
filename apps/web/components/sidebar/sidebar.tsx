// Imported by app/(main)/layout.tsx, a Server Component — see header.tsx for
// why the client boundary lives here and not in the layout.
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/workouts', label: 'Workouts' },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-48 shrink-0 border-r border-zinc-200 px-3 py-6 dark:border-zinc-800">
      <nav className="flex flex-col gap-1">
        {NAV_LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={`rounded-md px-3 py-2 text-sm font-medium ${
                active
                  ? 'bg-zinc-100 text-black dark:bg-zinc-900 dark:text-zinc-50'
                  : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
