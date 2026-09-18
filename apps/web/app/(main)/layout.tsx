import { Header } from '@components/header';
import { Sidebar } from '@components/sidebar';

export default function MainLayout({ children }: LayoutProps<'/'>) {
  return (
    // min-h-0 on the row is what makes the scroll land on <main>: a flex child
    // defaults to min-height:auto and refuses to shrink below its content, which
    // pushes the overflow back out to the document.
    <div className="flex h-dvh flex-col overflow-hidden">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
