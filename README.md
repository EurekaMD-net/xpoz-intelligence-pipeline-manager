# Xpoz Intelligence Pipeline Manager

Redefinición del scraper de Reddit como un pipeline de inteligencia utilizando la infraestructura de Xpoz para el acceso a datos, eliminando la necesidad de gestión directa de autenticación y rate-limiting.

---

## Plan de Arquitectura

### Premisa

El proyecto deja de ser un "scraper" (resolver autenticación + rate limiting) y se convierte en un **pipeline de inteligencia**: Xpoz resuelve el acceso a los datos, nosotros construimos la capa de valor encima.

---

### Arquitectura General

```
Xpoz API → Ingestión → Normalización → Análisis → Storage → Output
```

---

### Módulos

**1. Ingestor** (`ingest/`)
- Recibe una lista de subreddits target + keywords
- Llama a Xpoz en paralelo: `getRedditSubredditWithPostsByName` + `getRedditPostsByKeywords`
- Configurable: frecuencia, profundidad (top 100, hot, new), ventana de tiempo
- Output: JSON crudo normalizado

**2. Normalizador** (`transform/`)
- Deduplica posts que aparecen en múltiples subs
- Extrae campos relevantes: título, score, comments, fecha, subreddit, URL
- Filtra ruido (score mínimo configurable, eliminación de bots conocidos)

**3. Analizador Semántico** (`analyze/`)
- Agrupa posts por tópico (clustering por embeddings o por LLM call)
- Genera un "tópico canónico" por cluster: título, posts relacionados, score agregado
- Detecta tópicos **nuevos vs. recurrentes** (comparando con run anterior)
- Output: ranked list de tópicos con metadata

**4. Storage** (`store/`)
- SQLite local (simple, sin dependencias)
- Tablas: `runs`, `posts`, `topics`, `topic_history`
- Permite consultas históricas: "¿cuándo surgió este tópico?", "¿está creciendo o muriendo?"

**5. Output** (`report/`)
- Markdown formateado (para Jarvis / Telegram)
- JSON estructurado (para integraciones futuras: LivingJoyfully, EurekaMD)
- Opcional: comparativa vs. run anterior ("subió", "bajó", "nuevo")

---

### Configuración

Un solo archivo `config.ts` con:
- Subreddits por dominio (longevity, immortality, transhumanism, biohacking)
- Keywords adicionales para búsqueda cruzada
- Score mínimo, número de posts por subreddit, idioma
- Credenciales Xpoz (Bearer token)

---

### Modos de Ejecución

| Modo | Descripción |
|------|-------------|
| `run once` | Un análisis manual, output a consola/archivo |
| `scheduled` | Cron diario, guarda en SQLite, alerta si hay tópicos nuevos |
| `query` | Consulta histórica: "¿qué tópicos surgieron esta semana?" |

---

### Integración con Jarvis (Fase 2)

- El Intelligence Depot puede consumir el output del pipeline como señal diaria
- Jarvis puede llamar `query` para incluir longevity intel en el reporte matutino
- Eventualmente: alertas Flash si surge un tópico con velocidad inusual

---

### Fases de Construcción

| Fase | Qué construimos | Criterio de éxito |
|------|----------------|-------------------|
| **Fase 1** | Ingestor + Normalizador | Run manual produce JSON limpio de 3+ subs |
| **Fase 2** | Analizador + Storage | Top 10 tópicos guardados en SQLite, comparables entre runs |
| **Fase 3** | Output + Reporte | Markdown/JSON generado automáticamente |
| **Fase 4** | Scheduling + Alertas | Corre diario, alerta en Telegram si hay tópico nuevo |
| **Fase 5** | Integración Jarvis | Aparece en Intel Depot o reporte matutino |

---

### Lo que NO construimos (por ahora)

- No scraping directo a Reddit (Xpoz lo hace)
- No UI / dashboard web
- No análisis de sentimiento (overkill para v1)
- No soporte multi-plataforma (solo Reddit por ahora)

---

### Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| Lenguaje | TypeScript (ESM) |
| Runtime | Node.js / tsx |
| Acceso a datos | Xpoz MCP API (Bearer token) |
| Storage | SQLite (`better-sqlite3`) |
| Análisis semántico | LLM call (Claude) via Jarvis |
| Output | Markdown + JSON |
| Scheduler (fase 4) | `node-cron` |

---

## Xpoz API

- **Endpoint:** `https://mcp.xpoz.ai/mcp`
- **Auth:** `Authorization: Bearer <token>`
- **Herramientas Reddit disponibles:**
  - `getRedditSubredditWithPostsByName`
  - `getRedditPostsByKeywords`
  - `searchRedditSubreddits`
  - + 4 herramientas adicionales
- **Plan:** Sin expiración · `isActive: true`
- **Cuenta:** peter.blades@gmail.com (Google OAuth)

---

## Estado del Proyecto

| Campo | Estado |
|-------|--------|
| Repo | ✅ Creado |
| Plan de arquitectura | ✅ Documentado |
| Código | 🔜 Fase 1 pendiente |
| Xpoz API | ✅ Verificada y activa |

---

*Iniciado: 22 abril 2026 · EurekaMD-net*
