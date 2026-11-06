import '@/styles/globals.css';
import Shell from '@/components/Shell';

export const metadata = {
  title: 'My Recipes',
  description: 'A simple place to keep recipes in English and Hebrew.',
};

export default function RootLayout({ children }) {
  // lang/dir are set on the client from the saved language choice.
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
