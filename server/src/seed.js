import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getDb } from './db.js';
import { config, isMemoryDb } from './config.js';
import { createPost } from './services/posts.js';

const here = dirname(fileURLToPath(import.meta.url));
const legacyDir = join(here, '..', '..', 'jawdhiwao');

function copyAsset(name, destName) {
  const src = join(legacyDir, name);
  if (!existsSync(src)) return null;
  const dest = join(config.uploadsDir, destName);
  try {
    copyFileSync(src, dest);
    return `${config.uploadsUrl}/${destName}`;
  } catch {
    return null;
  }
}

const SAMPLE_POSTS = [
  {
    title: 'A Copa do Mundo FIFA 2026',
    author: 'Fellipe Bittencourt',
    slug: 'copa-do-mundo-fifa-2026',
    cover: 'imagem-blog.png',
    coverName: 'worldcup-blog.png',
    content: `
      <h2>A Copa do Mundo FIFA 2026</h2>
      <p>Copa do Mundo FIFA de 2026: novo formato e caminho até o Mundial.</p>
      <p>A Copa do Mundo FIFA de 2026 marcará uma nova era do futebol mundial. Pela primeira vez, o torneio contará com 48 seleções e será realizado em três países-sede: Canadá, Estados Unidos e México.</p>
      <hr data-page-break>
      <h2>O novo formato</h2>
      <p>No novo formato, as 48 seleções são distribuídas em 12 grupos de quatro equipes. As duas melhores colocadas de cada grupo avançam para a fase eliminatória, juntamente com os oito melhores terceiros colocados.</p>
      <p>A classificação acontece por meio das eliminatórias organizadas pelas confederações continentais. Os países-sede garantem vaga automática no Mundial.</p>
      <p>Com mais equipes, mais jogos e uma abrangência global ainda maior, a Copa do Mundo FIFA de 2026 promete ser uma das edições mais inclusivas e emocionantes da história do futebol.</p>
    `,
  },
  {
    title: 'O Brasil na Copa do Mundo',
    author: 'Fellipe Bittencourt',
    slug: 'o-brasil-na-copa-do-mundo',
    cover: 'imagem-copa.jpeg',
    coverName: 'worldcup-copa.png',
    content: `
      <h2>O Brasil na Copa do Mundo</h2>
      <p>A Seleção Brasileira e o sonho do hexa na Copa do Mundo de 2026.</p>
      <p>Para a Seleção Brasileira, a Copa representa mais uma oportunidade de conquistar o tão esperado hexacampeonato. O time conta com jogadores decisivos e um elenco capaz de competir em alto nível.</p>
      <hr data-page-break>
      <h2>O caminho até a final</h2>
      <p>O caminho até a final, no entanto, não será simples. O chaveamento pode colocar adversários tradicionais no caminho do Brasil, incluindo seleções como Inglaterra e Argentina nas fases decisivas.</p>
      <p>Se conseguir manter regularidade, equilíbrio defensivo e aproveitar o talento de seus principais jogadores, a Seleção Brasileira tem condições reais de chegar à final e lutar pelo sexto título mundial.</p>
    `,
  },
];

export function seedSamplePosts() {
  if (isMemoryDb) return;
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c;
  if (count > 0) return;

  for (const sample of SAMPLE_POSTS) {
    const cover = copyAsset(sample.cover, sample.coverName);
    createPost({
      title: sample.title,
      author: sample.author,
      slug: sample.slug,
      cover_image: cover,
      content: sample.content,
      status: 'published',
    });
  }
  console.log(`Seeded ${SAMPLE_POSTS.length} sample posts.`);
}
