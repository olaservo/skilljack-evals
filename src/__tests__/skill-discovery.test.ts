import { describe, it, expect } from 'vitest';
import { parseFrontmatter, stripFrontmatter } from '../runner/skill-discovery.js';

describe('parseFrontmatter', () => {
  it('parses valid YAML frontmatter', () => {
    const content = `---
name: greeting
description: A friendly greeting skill
---
# Greeting Skill

Say hello!`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({ name: 'greeting', description: 'A friendly greeting skill' });
  });

  it('returns empty object when no frontmatter present', () => {
    const content = '# Just a heading\n\nSome content.';
    expect(parseFrontmatter(content)).toEqual({});
  });

  it('handles frontmatter with quoted values', () => {
    const content = `---
name: "my-skill"
description: 'A skill with quotes'
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({ name: 'my-skill', description: 'A skill with quotes' });
  });

  it('handles frontmatter with only some fields', () => {
    const content = `---
name: partial
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({ name: 'partial' });
  });
});

describe('stripFrontmatter', () => {
  it('strips frontmatter and returns body', () => {
    const content = `---
name: test
---
# Body Content

Paragraph here.`;
    expect(stripFrontmatter(content)).toBe('# Body Content\n\nParagraph here.');
  });

  it('returns content as-is when no frontmatter', () => {
    const content = '# No frontmatter\n\nJust body.';
    expect(stripFrontmatter(content)).toBe('# No frontmatter\n\nJust body.');
  });

  it('trims whitespace from result', () => {
    const content = `---
name: test
---

  Indented content  `;
    expect(stripFrontmatter(content)).toBe('Indented content');
  });
});
