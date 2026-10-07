const journalFiles = import.meta.glob('./journal/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
})

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)

  if (!match) {
    return { metadata: {}, content: source }
  }

  const metadata = Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(':')
        const key = line.slice(0, separator).trim()
        const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
        return [key, value]
      }),
  )

  return { metadata, content: match[2] }
}

export const journalEntries = Object.entries(journalFiles)
  .map(([path, source]) => {
    const slug = path.split('/').pop().replace('.md', '')
    const { metadata, content } = parseFrontmatter(source)

    return {
      slug,
      title: metadata.title,
      date: metadata.date,
      displayDate: metadata.displayDate,
      summary: metadata.summary,
      topics: metadata.topics ? metadata.topics.split(',').map((topic) => topic.trim()) : [],
      content,
    }
  })
  .sort((a, b) => b.date.localeCompare(a.date))
