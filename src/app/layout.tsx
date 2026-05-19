import type { Metadata } from 'next';
import { I18nProvider } from '@/lib/i18n';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'MySkills',
  description: 'AI Skill Hub — unified management of AI agent skills',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `lang` is updated client-side by I18nProvider when the user toggles.
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="h-screen overflow-hidden bg-background text-foreground antialiased">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
