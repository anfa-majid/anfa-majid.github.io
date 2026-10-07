import { NavLink, Route, Routes, Link, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { journalEntries } from './content.js'
import { manuscripts, siteConfig } from './siteConfig.js'

const navItems = [
  { label: 'About', to: '/' },
  { label: 'Manuscripts', to: '/manuscripts' },
  { label: 'Engineering Journal', to: '/journal' },
  { label: 'CV', to: '/cv' },
]

function Header() {
  return (
    <header className="site-header">
      <Link className="wordmark" to="/" aria-label="Anfa Majid, home">
        <span>Anfa Majid</span>
      </Link>
      <nav className="site-nav" aria-label="Primary navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  )
}

function Footer() {
  return (
    <footer className="site-footer">
      <span>© {new Date().getFullYear()} Anfa Majid</span>
      <a href={siteConfig.githubUrl} target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
    </footer>
  )
}

function PageIntro({ eyebrow, title, children }) {
  return (
    <header className="page-intro">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {children && <p className="page-deck">{children}</p>}
    </header>
  )
}

function Topics({ items }) {
  return (
    <ul className="topic-list" aria-label="Topics">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  )
}

function About() {
  return (
    <main className="home page-shell">
      <section className="home-copy" aria-labelledby="home-title">
        <p className="eyebrow">Software Engineering · Research and Development</p>
        <h1 id="home-title">I work on systems that manage and protect data.</h1>
        <p className="home-lead">
          I work at the intersection of software engineering and research and development. I’m an IBA Karachi graduate, and my work sits across enterprise software, data intensive systems, storage, identity and access, and cloud infrastructure.
        </p>
        <p>
          I’m interested in how these systems behave at scale: how components communicate, where failures appear, how access is controlled, and how reliable infrastructure can support AI and machine learning workloads. I use this site to document my research and the engineering problems I have worked through.
        </p>
      </section>
      <aside className="interest-note" aria-label="Research interests">
        <p className="note-label">Areas I keep returning to</p>
        <ul>
          <li>Enterprise systems</li>
          <li>Data intensive systems</li>
          <li>Distributed systems</li>
          <li>Storage systems</li>
          <li>Cloud infrastructure</li>
          <li>Systems security</li>
          <li>Identity and access</li>
          <li>Systems for AI and machine learning</li>
        </ul>
      </aside>
      <section className="personal-note" aria-labelledby="away-title">
        <h2 id="away-title">Away from the work</h2>
        <p>
          Outside work, I spend a lot of time on court. I’m always up for a game of tennis, squash, or pickleball, whether it is competitive or simply a good way to reset.
        </p>
      </section>
    </main>
  )
}

function ManuscriptCard({ manuscript, muted = false }) {
  return (
    <article className={`manuscript-card${muted ? ' muted' : ''}`}>
      <div>
        <h3>{manuscript.title}</h3>
        <p>{manuscript.description}</p>
        {manuscript.background && (
          <div className="manuscript-context">
            <h4>Why this research</h4>
            <p>{manuscript.background}</p>
          </div>
        )}
        {manuscript.question && (
          <div className="research-question">
            <span>Research question</span>
            <p>{manuscript.question}</p>
          </div>
        )}
        {manuscript.impact && (
          <div className="manuscript-impact">
            <h4>Real world impact</h4>
            <p>{manuscript.impact}</p>
          </div>
        )}
        <Topics items={manuscript.topics} />
        {manuscript.links?.length > 0 && (
          <div className="manuscript-links">
            {manuscript.links.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                {link.label} <span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
        )}
      </div>
      {manuscript.status ? (
        <span className="status">{manuscript.status}</span>
      ) : (
        muted && <span className="status">In progress</span>
      )}
    </article>
  )
}

function Manuscripts() {
  return (
    <main className="page-shell narrow">
      <PageIntro eyebrow="Research" title="Manuscripts">
        My research begins with problems that appear in real systems. I turn those problems into focused questions, study them through controlled experiments and measurement, and connect the evidence back to practical engineering decisions.
      </PageIntro>

      <section className="section-block" aria-labelledby="completed-title">
        <div className="section-heading">
          <h2 id="completed-title">Completed work</h2>
          <span>{manuscripts.completed.length}</span>
        </div>
        {manuscripts.completed.length ? (
          <div className="manuscript-list">
            {manuscripts.completed.map((item) => <ManuscriptCard key={item.title} manuscript={item} />)}
          </div>
        ) : (
          <p className="empty-state">Completed manuscripts will be added here as they become available.</p>
        )}
      </section>

      <section className="section-block ongoing" aria-labelledby="ongoing-title">
        <div className="section-heading">
          <h2 id="ongoing-title">Ongoing work</h2>
          <span>{manuscripts.ongoing.length}</span>
        </div>
        {manuscripts.ongoing.length ? (
          <div className="manuscript-list">
            {manuscripts.ongoing.map((item) => <ManuscriptCard key={item.title} manuscript={item} muted />)}
          </div>
        ) : (
          <p className="empty-state">No ongoing manuscripts are listed at the moment.</p>
        )}
      </section>
    </main>
  )
}

function Journal() {
  return (
    <main className="page-shell narrow">
      <PageIntro eyebrow="Engineering journal" title="Notes from engineering practice">
        Detailed, first person writing about systems and infrastructure I have worked with in industry. Each entry explains the problem, how the components interact, why the design matters, and what the experience taught me about building dependable systems.
      </PageIntro>
      <div className="journal-list">
        {journalEntries.map((entry, index) => (
          <article className="journal-row" key={entry.slug}>
            <div className="journal-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
            <div className="journal-summary">
              <p className="entry-date">{entry.displayDate}</p>
              <h2><Link to={`/journal/${entry.slug}`}>{entry.title}</Link></h2>
              <p>{entry.summary}</p>
              <Topics items={entry.topics} />
            </div>
            <Link className="read-link" to={`/journal/${entry.slug}`} aria-label={`Read ${entry.title}`}>
              Read <span aria-hidden="true">→</span>
            </Link>
          </article>
        ))}
      </div>
    </main>
  )
}

function JournalArticle() {
  const { slug } = useParams()
  const entry = journalEntries.find((item) => item.slug === slug)

  if (!entry) return <NotFound />

  return (
    <main className="article-shell">
      <Link className="back-link" to="/journal"><span aria-hidden="true">←</span> Engineering Journal</Link>
      <header className="article-header">
        <p className="eyebrow">{entry.displayDate}</p>
        <h1>{entry.title}</h1>
        <p className="article-summary">{entry.summary}</p>
        <Topics items={entry.topics} />
      </header>
      <article className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
      </article>
      <footer className="article-footer">
        <p>More notes as I keep learning.</p>
        <Link to="/journal">All journal entries <span aria-hidden="true">→</span></Link>
      </footer>
    </main>
  )
}

function CV() {
  return (
    <main className="page-shell narrow">
      <PageIntro eyebrow="Professional record" title="Curriculum vitae">
        My complete experience, research, education, projects, technical skills, and leadership record.
      </PageIntro>

      <section className="cv-document" aria-labelledby="cv-document-title">
        <div className="cv-document-bar">
          <div>
            <p className="cv-label">Full CV</p>
            <h2 id="cv-document-title">Anfa Majid</h2>
          </div>
          <div className="cv-document-actions">
            <a href={siteConfig.cvPdfUrl} target="_blank" rel="noreferrer">Open PDF <span aria-hidden="true">↗</span></a>
            <a href={siteConfig.cvPdfUrl} download>Download <span aria-hidden="true">↓</span></a>
          </div>
        </div>

        <div className="cv-pdf-shell">
          <iframe
            className="cv-pdf-frame"
            src={`${siteConfig.cvPdfUrl}#view=FitH`}
            title="Anfa Majid curriculum vitae"
          />
        </div>

        <div className="cv-document-footer">
          <p>If the document does not display in your browser, use the open or download link above.</p>
          <div className="cv-contact-links">
            <a href={`mailto:${siteConfig.email}`}>Email</a>
            <a href={siteConfig.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn <span aria-hidden="true">↗</span></a>
            <a href={siteConfig.githubUrl} target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
          </div>
        </div>
      </section>
    </main>
  )
}

function NotFound() {
  return (
    <main className="page-shell narrow not-found">
      <p className="eyebrow">404</p>
      <h1>That page isn’t here.</h1>
      <Link to="/">Return home <span aria-hidden="true">→</span></Link>
    </main>
  )
}

export default function App() {
  return (
    <div className="site-frame">
      <Header />
      <Routes>
        <Route path="/" element={<About />} />
        <Route path="/manuscripts" element={<Manuscripts />} />
        <Route path="/journal" element={<Journal />} />
        <Route path="/journal/:slug" element={<JournalArticle />} />
        <Route path="/cv" element={<CV />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Footer />
    </div>
  )
}
