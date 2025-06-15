// index.js

const express = require('express'); // Necesario para iniciar un servidor HTTP en Cloud Run
const Parser = require('rss-parser');
const parser = new Parser();
const { VertexAI } = require('@google-cloud/vertexai');
// No se necesitan SecretManagerServiceClient ni axios para esta versión sin Facebook.

const app = express();
app.use(express.json()); // Para parsear cuerpos JSON en caso de que el trigger sea un POST con body

// --- Configuración de Google Cloud ---
const project = process.env.GCP_PROJECT || 'zapzap-462322'; // Usa la variable de entorno o tu Project ID
const location = 'us-central1'; // Asegúrate de que esta sea la región donde está tu modelo Gemini

// Inicialización del cliente de Vertex AI para Gemini
const vertex_ai = new VertexAI({ project, location });
const model = vertex_ai.getGenerativeModel({
  model: 'gemini-2.0-flash-001' // Asegúrate de que este modelo esté disponible en tu región
});

const generationConfig = {
  temperature: 0.7, // Un poco más creativo para una nota periodística
};

// No se necesitan secretManagerClient ni accessSecretVersion para esta versión sin Facebook.

// Lista de RSS que analizarás (VERSION ACTUALIZADA Y CORRECTA)
const rssFeeds = [
  'https://www.excelsior.com.mx/rss',
  'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/mexico/portada',
  'https://editorial.aristeguinoticias.com/category/mexico/feed/',
  'https://heraldodemexico.com.mx/rss/feed.html?r=4',
];

/**
 * Función principal que ejecuta la lógica de lectura de RSS y generación de nota periodística.
 * Se envolverá en una ruta HTTP para Cloud Run.
 */
async function executeRssToNewsArticleFlow() { // Nuevo nombre para reflejar el cambio
  console.log('Inicio de la ejecución del flujo RSS a Nota Periodística con Gemini.');
  let noticias = [];

  // --- 1. Leer todos los feeds RSS y recopilar noticias ---
  console.log('Comenzando la lectura de feeds RSS...');
  for (const feedUrl of rssFeeds) {
    try {
      const feed = await parser.parseURL(feedUrl);
      console.log(`Feed '${feed.title}' (${feedUrl}) parseado. Encontrados ${feed.items.length} elementos.`);
      feed.items.forEach(item => {
        noticias.push({
          title: item.title,
          link: item.link,
          pubDate: item.pubDate,
          contentSnippet: item.contentSnippet || '',
          source: feed.title
        });
      });
    } catch (feedError) {
      console.warn(`[ADVERTENCIA] Error al procesar feed '${feedUrl}': ${feedError.message}`);
    }
  }

  noticias.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const noticiasParaProcesar = noticias.slice(0, 5); // Procesar las 5 noticias más recientes
  console.log(`Se seleccionaron ${noticiasParaProcesar.length} noticias para generar notas periodísticas.`);

  // --- 2. Generar notas periodísticas para cada noticia con Gemini ---
  const notasGeneradas = [];
  if (noticiasParaProcesar.length === 0) {
      console.log('No hay noticias nuevas o seleccionadas para generar notas periodísticas.');
  }

  for (const noticia of noticiasParaProcesar) {
    console.log(`Generando nota periodística para: "${noticia.title}"`);
    const prompt = `Basado en la siguiente noticia, escribe una nota periodística completa y detallada, con un estilo profesional y objetivo. Incluye:

1.  Un titular informativo y atractivo.
2.  Un lead (primer párrafo) que resuma lo más importante (qué, quién, cuándo, dónde, por qué).
3.  Desarrollo del cuerpo de la noticia con detalles adicionales, contexto, y si es posible, declaraciones o implicaciones (si la información lo permite).
4.  Cierre o conclusión.
5.  La nota debe tener una extensión adecuada para un artículo breve (aproximadamente 3-5 párrafos).

Título de la Noticia: "${noticia.title}"
Contenido/Extracto: "${noticia.contentSnippet}"
Enlace Original: ${noticia.link}`;

    const request = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    };

    try {
      const result = await model.generateContent(request);
      const generatedArticle = result.response.candidates[0].content.parts[0].text;
      console.log(`Nota periodística generada para "${noticia.title}":\n${generatedArticle.substring(0, 200)}...`); // Muestra solo un extracto en logs

      notasGeneradas.push({
        title: noticia.title,
        originalLink: noticia.link,
        source: noticia.source,
        newsArticle: generatedArticle // Aquí guardamos la nota periodística completa
      });
    } catch (geminiError) {
      console.error(`[ERROR] Fallo al generar nota periodística con Gemini para "${noticia.title}": ${geminiError.message}`);
    }
  }

  // --- En esta versión, el proceso se detiene aquí. No hay publicación en Facebook. ---
  console.log('Finalizando la ejecución del flujo RSS a Nota Periodística. No se generarán copys para redes sociales ni publicaciones.');
  
  return {
    success: true,
    message: 'Análisis de RSS y generación de notas periodísticas completados.',
    summary: {
        totalNewsFound: noticias.length,
        newsArticlesGenerated: notasGeneradas.length
    },
    generatedNewsArticles: notasGeneradas // Devolvemos las notas periodísticas generadas
  };
}


// Definir una ruta HTTP para activar el flujo
app.post('/', async (req, res) => {
    try {
        const result = await executeRssToNewsArticleFlow();
        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(500).json(result); // Enviar error si el flujo no fue exitoso
        }
    } catch (error) {
        console.error(`[ERROR FATAL] Error en el endpoint de Cloud Run: ${error.message}`);
        res.status(500).send(`Error interno del servidor: ${error.message}`);
    }
});

// Cloud Run proporciona el puerto en la variable de entorno PORT
const PORT = parseInt(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`La aplicación está escuchando en el puerto ${PORT}`);
});
