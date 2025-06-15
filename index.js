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
  temperature: 0.7, // Un poco más creativo para una nota periodística y copy
};

// Lista de RSS que analizarás (VERSION ACTUALIZADA Y CORRECTA - Proceso Eliminado)
const rssFeeds = [
  'https://www.excelsior.com.mx/rss.xml',
  'https://elpais.com/rss/feed.html?feedId=1022',
  'https://www.eleconomista.com.mx/rss.html',
  'https://www.jornada.com.mx/v7.0/cgi/rss.php',
  // 'https://www.proceso.com.mx/rss/', // Eliminado por problemas de formato
];

/**
 * Función principal que ejecuta la lógica de lectura de RSS, generación de nota periodística y copy para redes.
 * Se envolverá en una ruta HTTP para Cloud Run.
 */
async function executeRssToNewsArticleAndSocialCopyFlow() { // Nuevo nombre de función
  console.log('Inicio de la ejecución del flujo RSS a Nota Periodística y Copy para Redes con Gemini.');
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
  console.log(`Se seleccionaron ${noticiasParaProcesar.length} noticias para generar notas periodísticas y copys de redes.`);

  // --- 2. Generar notas periodísticas y copies para redes con Gemini ---
  const resultadosGenerados = []; // Cambiado el nombre para incluir ambos resultados
  if (noticiasParaProcesar.length === 0) {
      console.log('No hay noticias nuevas o seleccionadas para procesar.');
  }

  for (const noticia of noticiasParaProcesar) {
    console.log(`Procesando noticia: "${noticia.title}"`);

    let generatedArticle = '';
    let socialMediaCopy = '';

    // --- PRIMERA LLAMADA A GEMINI: Generar Nota Periodística ---
    const newsArticlePrompt = `Basado en la siguiente noticia, escribe una nota periodística completa y detallada, con un estilo profesional y objetivo. Incluye:

1.  Un titular informativo y atractivo.
2.  Un lead (primer párrafo) que resuma lo más importante (qué, quién, cuándo, dónde, por qué).
3.  Desarrollo del cuerpo de la noticia con detalles adicionales, contexto, y si es posible, declaraciones o implicaciones (si la información lo permite).
4.  Cierre o conclusión.
5.  La nota debe tener una extensión adecuada para un artículo breve (aproximadamente 3-5 párrafos).

Título de la Noticia: "${noticia.title}"
Contenido/Extracto: "${noticia.contentSnippet}"
Enlace Original: ${noticia.link}`;

    const newsArticleRequest = {
      contents: [{ role: 'user', parts: [{ text: newsArticlePrompt }] }],
      generationConfig,
    };

    try {
      const newsArticleResult = await model.generateContent(newsArticleRequest);
      generatedArticle = newsArticleResult.response.candidates[0].content.parts[0].text;
      console.log(`Nota periodística generada para "${noticia.title}":\n${generatedArticle.substring(0, 200)}...`);
    } catch (geminiError) {
      console.error(`[ERROR] Fallo al generar nota periodística con Gemini para "${noticia.title}": ${geminiError.message}`);
      // Continuar aunque falle la nota para intentar generar el copy, o puedes optar por saltar esta noticia
      generatedArticle = `[ERROR AL GENERAR NOTA: ${geminiError.message}]`;
    }

    // --- SEGUNDA LLAMADA A GEMINI: Generar Copy para Redes Sociales (usando la nota generada) ---
    if (generatedArticle && !generatedArticle.startsWith('[ERROR AL GENERAR NOTA')) { // Solo si la nota se generó bien
        const socialMediaCopyPrompt = `Crea un copy corto y atractivo para redes sociales (máximo 2 líneas, con 1-2 emojis) basado en la siguiente nota periodística. El objetivo es captar la atención y dirigir al lector a leer más. No incluyas hashtags ni menciones.

        Nota periodística:
        "${generatedArticle}"`;

        const socialMediaCopyRequest = {
            contents: [{ role: 'user', parts: [{ text: socialMediaCopyPrompt }] }],
            generationConfig,
        };

        try {
            const socialMediaCopyResult = await model.generateContent(socialMediaCopyRequest);
            socialMediaCopy = socialMediaCopyResult.response.candidates[0].content.parts[0].text;
            console.log(`Copy para redes generado para "${noticia.title}": ${socialMediaCopy}`);
        } catch (copyError) {
            console.error(`[ERROR] Fallo al generar copy para redes con Gemini para "${noticia.title}": ${copyError.message}`);
            socialMediaCopy = `[ERROR AL GENERAR COPY: ${copyError.message}]`;
        }
    } else {
        socialMediaCopy = '[NO SE GENERÓ COPY POR ERROR EN LA NOTA]';
    }


    resultadosGenerados.push({
      title: noticia.title,
      originalLink: noticia.link,
      source: noticia.source,
      newsArticle: generatedArticle,
      socialMediaCopy: socialMediaCopy // ¡Nuevo campo para el copy de redes!
    });
  }

  console.log('Finalizando la ejecución del flujo RSS a Nota Periodística y Copy para Redes. No se realizarán publicaciones.');
  
  return {
    success: true,
    message: 'Análisis de RSS, generación de notas periodísticas y copies para redes completados.',
    summary: {
        totalNewsFound: noticias.length,
        newsArticlesGenerated: resultadosGenerados.filter(r => !r.newsArticle.startsWith('[ERROR')).length,
        socialMediaCopiesGenerated: resultadosGenerados.filter(r => !r.socialMediaCopy.startsWith('[ERROR')).length
    },
    generatedContent: resultadosGenerados // Devolvemos ambos resultados
  };
}


// Definir una ruta HTTP para activar el flujo
app.post('/', async (req, res) => {
    try {
        const result = await executeRssToNewsArticleAndSocialCopyFlow(); // Nuevo nombre de función
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
