/**
 * Recognising technology names in resume text.
 *
 * These tags are not decoration. Phase 5's provenance guard permits a tailored
 * bullet to name a technology only if it is in the union of the profile's tech
 * tags and the candidate's enabled SkillsReserve - so this file decides what the
 * model is allowed to say the candidate has worked with. That makes a MISSED tag
 * cheap (a rewrite loses a word) and a WRONG tag expensive (a rewrite gains a
 * claim the candidate cannot back up in an interview). The dictionary is therefore
 * deliberately conservative about ambiguous names.
 *
 * The dictionary is not, and cannot be, complete - "Docling" is in this
 * candidate's resume and in nobody's list of well-known tools. Two mechanisms
 * cover that without guessing:
 *
 *   - `splitTechList` reads the explicit lists a resume already contains - the
 *     SKILLS section and "Tech Stack:" lines - VERBATIM. Anything the candidate
 *     wrote down as a skill is a skill, dictionary or not.
 *   - anything still missing is a one-line SkillsReserve entry, which is a
 *     deliberate human act rather than an inference.
 *
 * Case is normalised to the canonical spelling on the left, because "mongodb",
 * "MongoDb" and "Mongo DB" are one skill and three separate strings would make
 * the guard's set membership test miss.
 */

/**
 * canonical name -> the other ways it gets written.
 *
 * NOT INCLUDED ON PURPOSE: bare "Go", "R", "C", "Rust" as a word, "Swift",
 * "Dart". Each is a common English word or single letter, and a resume sentence
 * like "Go to market" or "C level" would tag a language the candidate never
 * used. The multi-word aliases ("Golang") are safe and are what is matched
 * instead. A candidate who really writes Go lists it in their SKILLS section,
 * where `splitTechList` reads it verbatim.
 */
const TECH_ALIASES: Record<string, string[]> = {
  // Languages and runtimes
  TypeScript: ['typescript', 'ts'],
  JavaScript: ['javascript'],
  Python: ['python'],
  Java: ['java'],
  Kotlin: ['kotlin'],
  Golang: ['golang'],
  'C++': ['c++', 'cpp'],
  'C#': ['c#', 'csharp'],
  PHP: ['php'],
  Ruby: ['ruby'],
  Scala: ['scala'],
  Bash: ['bash', 'shell scripting'],
  SQL: ['sql'],

  // Backend frameworks
  'Node.js': ['node.js', 'nodejs', 'node js'],
  'Nest.js': ['nest.js', 'nestjs', 'nest js'],
  'Express.js': ['express.js', 'expressjs', 'express'],
  Fastify: ['fastify'],
  Django: ['django'],
  Flask: ['flask'],
  FastAPI: ['fastapi'],
  Spring: ['spring boot', 'springboot', 'spring'],
  'Ruby on Rails': ['ruby on rails', 'rails'],
  Laravel: ['laravel'],
  GraphQL: ['graphql'],
  gRPC: ['grpc'],
  REST: ['rest api', 'rest apis', 'restful'],
  WebSockets: ['websocket', 'websockets'],
  'Socket.IO': ['socket.io', 'socketio'],

  // Frontend
  'React.js': ['react.js', 'reactjs', 'react'],
  'Next.js': ['next.js', 'nextjs'],
  'Vue.js': ['vue.js', 'vuejs', 'vue'],
  Angular: ['angular', 'angularjs'],
  Svelte: ['svelte', 'sveltekit'],
  'React Native': ['react native'],
  Flutter: ['flutter'],
  Redux: ['redux'],
  'Tailwind CSS': ['tailwind css', 'tailwindcss', 'tailwind'],
  HTML: ['html', 'html5'],
  CSS: ['css', 'css3'],
  SCSS: ['scss', 'sass'],

  // Data stores
  PostgreSQL: ['postgresql', 'postgres', 'psql'],
  MySQL: ['mysql'],
  MongoDB: ['mongodb', 'mongo db', 'mongo'],
  Redis: ['redis'],
  SQLite: ['sqlite'],
  Elasticsearch: ['elasticsearch', 'elastic search'],
  OpenSearch: ['opensearch'],
  DynamoDB: ['dynamodb'],
  Cassandra: ['cassandra'],
  Neo4j: ['neo4j'],
  ClickHouse: ['clickhouse'],
  Snowflake: ['snowflake'],
  BigQuery: ['bigquery'],

  // Vector stores - listed individually because "Vector DB" as a tag says
  // nothing about whether the candidate has run one in production.
  pgvector: ['pgvector'],
  Pinecone: ['pinecone'],
  Weaviate: ['weaviate'],
  Qdrant: ['qdrant'],
  Milvus: ['milvus'],
  ChromaDB: ['chromadb', 'chroma db'],
  FAISS: ['faiss'],
  'Vector Databases': [
    'vector database',
    'vector databases',
    'vector db',
    'vectordb',
    'vector dbs',
  ],

  // AI / ML
  LLM: ['llm', 'llms', 'large language model', 'large language models'],
  RAG: ['rag', 'retrieval augmented generation', 'retrieval-augmented generation'],
  'Agentic AI': ['agentic ai', 'ai agents', 'agentic'],
  Embeddings: ['embedding', 'embeddings'],
  'Prompt Engineering': ['prompt engineering'],
  'Fine-tuning': ['fine-tuning', 'finetuning', 'fine tuning'],
  OpenAI: ['openai', 'open ai'],
  Anthropic: ['anthropic', 'claude'],
  Gemini: ['gemini'],
  Mistral: ['mistral'],
  'Hugging Face': ['hugging face', 'huggingface'],
  LangChain: ['langchain', 'lang chain'],
  LlamaIndex: ['llamaindex', 'llama index'],
  PyTorch: ['pytorch'],
  TensorFlow: ['tensorflow'],
  'scikit-learn': ['scikit-learn', 'sklearn'],
  Pandas: ['pandas'],
  NumPy: ['numpy'],
  spaCy: ['spacy'],
  OCR: ['ocr'],
  'Computer Vision': ['computer vision'],
  NLP: ['nlp', 'natural language processing'],

  // Queues, pipelines, infra
  Kafka: ['kafka', 'apache kafka'],
  RabbitMQ: ['rabbitmq'],
  BullMQ: ['bullmq', 'bull'],
  Celery: ['celery'],
  Airflow: ['airflow', 'apache airflow'],
  'Worker Threads': ['worker threads', 'worker_threads'],
  Docker: ['docker'],
  Kubernetes: ['kubernetes', 'k8s'],
  Terraform: ['terraform'],
  Ansible: ['ansible'],
  Nginx: ['nginx'],
  Jenkins: ['jenkins'],
  'GitHub Actions': ['github actions'],
  'GitLab CI': ['gitlab ci'],
  'CI/CD': ['ci/cd', 'cicd'],
  AWS: ['aws', 'amazon web services'],
  GCP: ['gcp', 'google cloud'],
  Azure: ['azure'],
  Vercel: ['vercel'],
  Cloudflare: ['cloudflare'],
  Firebase: ['firebase'],
  Supabase: ['supabase'],
  Prisma: ['prisma'],
  TypeORM: ['typeorm'],
  Sequelize: ['sequelize'],
  Mongoose: ['mongoose'],
  Git: ['git'],
  Linux: ['linux'],
  Playwright: ['playwright'],
  Puppeteer: ['puppeteer'],
  Selenium: ['selenium'],
  Jest: ['jest'],
  Cypress: ['cypress'],
  Pytest: ['pytest'],
  Grafana: ['grafana'],
  Prometheus: ['prometheus'],
  Sentry: ['sentry'],

  // Domain standards that behave like tech on a resume
  'HL7/FHIR': ['hl7/fhir', 'hl7 fhir', 'fhir', 'hl7'],
  OAuth: ['oauth', 'oauth2', 'oauth 2.0'],
  JWT: ['jwt'],
  SAML: ['saml'],
  WebRTC: ['webrtc'],
  Stripe: ['stripe'],
  Razorpay: ['razorpay'],
  Twilio: ['twilio'],
};

/** Escapes a literal for use inside a RegExp. */
function escape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One compiled matcher per canonical name, longest alias first.
 *
 * Longest-first matters within an entry: `Express.js` must be tried before
 * `express`, or the `.js` is left dangling in the middle of a token.
 *
 * The boundaries are `(?<![A-Za-z0-9])` / `(?![A-Za-z0-9+#]|\.[A-Za-z0-9])` rather
 * than `\b`, because `\b` sits between `s` and `.` - so `\breact\b` matches inside
 * "React.js" and tags plain React on a posting that said Next. Excluding a
 * following `+` and `#` stops "C" matching in "C++"; excluding a preceding
 * alphanumeric stops "java" matching inside "JavaScript".
 *
 * THE TRAILING DOT IS CONDITIONAL, and it did not used to be. The lookahead was
 * `(?![A-Za-z0-9+#.])` - a flat ban on a following dot - which rejected "react" in
 * "react.js" as intended and ALSO rejected every technology at the end of a
 * sentence. "Deployed the service with Docker." returned no tags at all. That was
 * quietly expensive in ingestion, where it dropped real skills, and it was worse in
 * phase 5's provenance guard, which asks this function what technologies a rewritten
 * bullet names: "Built the pipeline on Kafka." named none, so the exact fabrication
 * the guard exists to catch walked through it.
 *
 * `\.[A-Za-z0-9]` bans the dot only when something wordlike follows it, which is
 * what a dotted product name looks like ("react.js", "jest.config", "spring.io") and
 * what sentence-final punctuation never does.
 */
const MATCHERS: { canonical: string; pattern: RegExp }[] = Object.entries(
  TECH_ALIASES,
).map(([canonical, aliases]) => ({
  canonical,
  pattern: new RegExp(
    `(?<![A-Za-z0-9])(?:${[...aliases]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join('|')})(?![A-Za-z0-9+#]|\\.[A-Za-z0-9])`,
    'i',
  ),
}));

/**
 * The technologies named in a piece of text, in canonical spelling.
 *
 * Order is the dictionary's, not the text's, so two atoms mentioning the same
 * pair of tools produce identical arrays and a diff between ingestions shows
 * only real changes.
 */
export function techIn(text: string): string[] {
  return MATCHERS.filter((m) => m.pattern.test(text)).map((m) => m.canonical);
}

/**
 * Splits an explicit list a resume already wrote out.
 *
 * Handles "AI / ML: LLM, RAG, Vector Databases" and
 * "Tech Stack: Node.js, React, MongoDb, PostgreSQL" - the label before the colon
 * is dropped, the items after it are kept VERBATIM apart from trimming, and each
 * item is then canonicalised if the dictionary knows it.
 *
 * Verbatim is the point: this is how "Docling" and "pgvector" become tags
 * without anyone extending the dictionary, and it is safe precisely because the
 * candidate is the one who wrote the list.
 */
export function splitTechList(line: string): string[] {
  // Only the FIRST colon - "Tech Stack: Node.js, GPT-4: fine-tuned" would
  // otherwise lose everything before the second one.
  const afterLabel = line.includes(':')
    ? line.slice(line.indexOf(':') + 1)
    : line;

  return afterLabel
    .split(/[,;|•]|\s+\/\s+/)
    .map((item) => item.trim().replace(/[.]$/, ''))
    .filter((item) => item.length > 0 && item.length <= 40)
    .map(canonicalise);
}

/**
 * Maps one written form to its canonical spelling, or returns it unchanged.
 *
 * Unchanged rather than dropped: an unknown item in a SKILLS list is a real skill
 * this file has not heard of, and discarding it would quietly narrow what
 * tailoring is allowed to mention.
 */
export function canonicalise(item: string): string {
  const found = MATCHERS.find((m) =>
    new RegExp(`^(?:${m.pattern.source})$`, 'i').test(item),
  );
  return found ? found.canonical : item;
}

/** Every canonical name the dictionary knows. Used by tests and diagnostics. */
export function knownTech(): string[] {
  return MATCHERS.map((m) => m.canonical);
}
