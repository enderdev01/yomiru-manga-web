<p align="center">
  <b>📚 Yomiru Manga</b><br>
  <sub>Ecosistema para leer manga y libros — app móvil (Expo), API, web (Astro) e ingestor, todo en un monorepo.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-3fb950?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Expo-000020?style=flat&logo=expo&logoColor=white" alt="Expo">
  <img src="https://img.shields.io/badge/Astro-BC52EE?style=flat&logo=astro&logoColor=white" alt="Astro">
  <img src="https://img.shields.io/badge/Fastify-000000?style=flat&logo=fastify&logoColor=white" alt="Fastify">
  <img src="https://img.shields.io/badge/Supabase-3FCF8E?style=flat&logo=supabase&logoColor=white" alt="Supabase">
</p>

---

## Qué hace

**Yomiru** (読みる — «leer») es un monorepo con el ecosistema completo de un lector de manga y libros: la app móvil en Expo, la API backend en Fastify, el sitio web en Astro, un ingestor/worker y paquetes compartidos. Usa Supabase (Postgres), Redis, R2 (Cloudflare) y enriquece el catálogo con MyAnimeList.

## Funcionalidades

- **App móvil** (Expo) para leer manga y libros.
- **API backend** (Fastify) con tests.
- **Web** (Astro) con SSR (adaptadores Vercel y Cloudflare).
- **Ingestor** que descubre y espeja capítulos de fuentes externas.
- Catálogo enriquecido con **MyAnimeList**.
- Paquetes compartidos: `db` (Drizzle), `shared` y `r2`.

## Requisitos

- **Node.js** ≥ 20 (ver [`.nvmrc`](./.nvmrc)).
- **npm** (workspaces).
- **Docker** (opcional, para Redis).

## Instalación

```bash
git clone https://github.com/OnichanDevTeam/yomiru-manga.git
cd yomiru-manga
npm install
```

## Scripts principales (raíz)

| Comando | Descripción |
|---------|-------------|
| `npm run mobile` | Dev de la app Expo (`@yomiru/mobile`) |
| `npm run backend` | Backend (`@yomiru/backend`) |
| `npm run web` | Sitio Astro en el puerto 3000 |
| `npm run web:build` | Build web para **Vercel** |
| `npm run web:build:cf` | Build web para **Cloudflare Pages** |
| `npm run ingestor` | Worker del ingestor |
| `npm run redis:up` | Levanta Redis con Docker Compose |
| `npm run db:generate` / `db:migrate` | Tareas de Drizzle |

## Estructura

```
apps/mobile     App React Native (Expo)
apps/backend    API (Fastify)
apps/web        Frontend Astro
apps/ingestor   Ingestor / worker
packages/db     Drizzle + esquema
packages/shared Código compartido
packages/r2     Acceso a Cloudflare R2
```

## Despliegue

El sitio web (`apps/web`) usa SSR (`output: 'server'`) con dos adaptadores:

- **Vercel**: root directory `apps/web`, build `cd ../.. && npm run web:build`.
- **Cloudflare Pages**: build `npm run web:build:cf`, output `apps/web/dist`.

### Variables de entorno (producción)

| Variable | Uso |
|----------|-----|
| `DATABASE_URL` | Postgres (Supabase) para catálogo |
| `R2_PUBLIC_URL` | URL pública del CDN de imágenes |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Media vía R2 sin URL pública |
| `ADMIN_SECRET` | Auth de rutas `/admin` |

---

<p align="center"><sub>Proyecto privado de <b>Onichan Dev Team</b> · <a href="mailto:anthoniriv01@gmail.com">anthoniriv01@gmail.com</a></sub></p>
