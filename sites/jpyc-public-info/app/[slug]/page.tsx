import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageBySlug, pages } from '../content';
import { DocumentShell } from '../site-shell';

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return pages.filter(({ slug }) => !['terms', 'privacy', 'refund-policy'].includes(slug)).map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = pageBySlug.get(slug);
  return page ? { title: page.title, description: page.summary } : {};
}

export default async function PublicDocumentPage({ params }: PageProps) {
  const { slug } = await params;
  const page = pageBySlug.get(slug);
  if (!page || ['terms', 'privacy', 'refund-policy'].includes(slug)) notFound();

  return (
    <DocumentShell eyebrow={page.eyebrow} title={page.title} summary={page.summary}>
      {page.sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          {section.bullets && <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}
        </section>
      ))}
    </DocumentShell>
  );
}
