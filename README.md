# Sistema de gestión, numeración e impresión de plásticos QR

Aplicación web para generar códigos QR únicos y numerados (001, 002, 003…), integrarlos en el diseño original del
plástico (10 × 15 cm), exportar archivos listos para imprimir y administrar desde un panel a dónde lleva cada QR.

- **Backend:** Node.js 22+ con Express. **Base de datos:** SQLite (módulo `node:sqlite` incluido en Node: no hace falta compilar nada en Windows).
- **Imágenes:** sharp (PNG), PDFKit (PDF vectorial), qrcode (generación), jsQR (lectura y verificación).
- **Interfaz:** HTML + JavaScript sin paso de compilación, en `public/`.

---

## 1. Instalación y ejecución en Windows

1. Instalá **Node.js 22 LTS o 24 LTS** desde <https://nodejs.org> (versión 22.13 o superior).
2. Descargá este proyecto (botón *Code → Download ZIP* en GitHub, o `git clone`) y descomprimilo, por ejemplo en `C:\plasticos-qr`.
3. Abrí **PowerShell** en esa carpeta (en el Explorador: clic en la barra de dirección, escribí `powershell` y Enter).
4. Instalá las dependencias:
   ```powershell
   npm install
   ```
5. Creá el archivo de configuración copiando el ejemplo:
   ```powershell
   copy .env.example .env
   notepad .env
   ```
   Para probar en tu PC podés dejarlo como está. **Antes de imprimir plásticos reales** cambiá `PUBLIC_BASE_URL`
   (ver sección 9).
6. Creá tu usuario administrador (te pide usuario y contraseña de 10 caracteres o más):
   ```powershell
   npm run crear-admin
   ```
7. Iniciá el servidor:
   ```powershell
   npm start
   ```
8. Entrá al panel en <http://localhost:3000/admin/> con el usuario creado.

Para detener el servidor: `Ctrl + C` en PowerShell. Los datos quedan guardados en `data\qr.db` y los diseños en
`data\uploads\`.

Otros comandos:

| Comando | Para qué sirve |
|---|---|
| `npm run crear-admin` | Crear otro administrador o cambiar una contraseña |
| `npm run backup` | Copia de seguridad (base + diseños) en `backups\` |
| `npm run migrar` | Aplica cambios de estructura de la base (hace copia antes) |
| `npm run prueba-diseno -- "C:\ruta\diseno.png"` | Prueba un diseño y genera muestras 001–003 **sin tocar la base real** |
| `npm test` | Ejecuta todas las pruebas automáticas |

---

## 2. Incorporar tu diseño (el plástico "¿Te gustó nuestro servicio?")

> **Importante:** la imagen del diseño que enviaste se vio en la conversación pero **no llegó como archivo** al
> entorno donde se desarrolló el sistema. Por eso **no se incluyó en el proyecto ni se recreó**: tenés que subir tu
> archivo original desde el panel (o probarlo con `npm run prueba-diseno`). No se usó ningún diseño inventado.

Sobre esa imagen se midió un **perfil de plantilla** llamado *“Reseña Google 10×15”* con estas ubicaciones
(en mm sobre el plástico de 100 × 150 mm). Son **estimaciones**: confirmalas con *Verificar* y una prueba impresa.

| Elemento | X | Y | Tamaño |
|---|---|---|---|
| QR nuevo (incluye 2 módulos de margen blanco) | 28,1 | 75,7 | 44 × 44 |
| Parche que tapa el QR original | 29,0 | 76,6 | 42,1 × 42,2 |
| Número dentro del plástico (debajo de “Escanea con tu celular”) | 35 | 133 | 30 × 7, 14 pt, gris #3C4043 |

Análisis del diseño: es una **imagen aplanada** (sin capas). El QR original está sobre una tarjeta blanca lisa, así
que se puede tapar con un parche blanco y dibujar encima el QR nuevo sin tocar el logo, las estrellas, los textos ni
la composición. Debajo de “Escanea con tu celular” hay espacio libre suficiente para el número.

Pasos:

1. Panel → **Diseños** → elegí el archivo PNG/JPG original (proporción 2:3; ideal 1181 × 1772 px o más = 300 ppp).
2. En *Ubicación inicial del QR* elegí **Perfil: Reseña Google 10×15** (o “Detectar el QR automáticamente”: funciona
   si el QR original es legible).
3. Se abre el **Editor de plantilla**: tres recuadros sobre tu diseño — azul (QR nuevo), naranja (parche) y verde
   (número). Arrastralos, cambiá el tamaño desde la esquina o escribí las medidas en mm.
4. **Color automático del parche** toma el color del fondo alrededor del QR.
5. **Guardar y verificar**. La verificación automática:
   - genera el diseño final y **lee el QR nuevo** para comprobar que contiene la URL correcta;
   - comprueba que **el QR original quedó tapado** y que no se puede leer;
   - avisa si el parche se va a notar (fondo no uniforme) o si el número tapa elementos del diseño;
   - informa resolución (ppp) y tamaño de los módulos del QR.

   No reemplaza mirar la vista previa y escanear una impresión de prueba.

Si el sistema no puede tapar limpiamente el QR original (fondo con degradé, foto, etc.), lo informa. La mejor
solución en ese caso es subir una versión del diseño **sin el QR** (zona vacía) y desactivar el parche.

La imagen debe tener proporción 2:3 exacta (tolerancia 1 %); si no, se rechaza en lugar de deformarla. El tamaño
físico se puede cambiar al subir (por ejemplo, si el proveedor pide sangrado), pero por defecto es 100 × 150 mm.

**Versiones:** cuando un diseño se usa en un lote, esa versión queda **bloqueada** (así cada unidad se puede volver
a exportar siempre igual). Para cambiar algo, “Nueva versión” crea una copia editable.

### Prueba rápida con tu archivo (genera 001, 002 y 003)

```powershell
npm run prueba-diseno -- "C:\ruta\a\tu-diseno.png"
```

Usa una base **temporal** (no consume la numeración real) y deja en `salida-prueba\<fecha>\` los PNG, PDF y SVG de
001, 002 y 003 y una plancha A3. Comprueba que los tres QR sean distintos, legibles, que cada uno contenga la URL de
su registro y que cada PDF mida 100 × 150 mm. Con `--detectar` usa la detección automática en vez del perfil.

---

## 3. Generar un lote

Panel → **Generar lote de QR**:

1. Elegí el diseño, la cantidad (1, 10, 50, 100, 500, 1000 o la que quieras), el formato (3 dígitos = 001; a partir
   de 1000 se amplía solo: 1000, 1001…) y un prefijo opcional (ej. `QR-`).
2. Elegí dónde va el número: **dentro del plástico**, **debajo de cada diseño en la plancha** o **en ambos**.
3. Revisá el resumen (lote, primer y último número, URL) y la vista previa de las primeras unidades.
4. **Confirmar y generar.** Los números quedan reservados para siempre: nunca se reutilizan, aunque una unidad se dé
   de baja.

Si el número no entra dentro del plástico, el sistema lo avisa y lo deja solo en la plancha (el producto físico no
tendrá número visible).

Cada unidad tiene: ID interno, número visible, identificador público aleatorio (12 caracteres), URL permanente
(`https://tu-dominio/q/<identificador>`), QR exclusivo, diseño y versión, lote, estado, destino, fecha e historial.

---

## 4. Imprimir los plásticos con su numeración

Panel → **Lotes e impresión** → elegí el lote:

- **Plancha PDF:** elegí papel (A4, A3, SRA3, A2, Carta, Oficio, Tabloide o personalizado), orientación, márgenes,
  separación, unidades por hoja y marcas de corte (solo si el fabricante las pide). El esquema muestra cómo queda la
  hoja y **cuántos diseños entran a tamaño real**. El diseño **nunca se reduce**: si no entra, el sistema lo dice.
  - Cada diseño lleva su número centrado debajo, en orden correlativo (001, 002, 003…).
  - El pie de página trae una **regla de 50 mm**: medila en la hoja impresa para confirmar la escala.
  - Referencia: A4 vertical = 1 por hoja; A4 horizontal = 2; A3 vertical = 4 (con márgenes de 8 mm).
- **ZIP:** PNG y PDF individuales de cada unidad (y SVG opcional), la plancha y el CSV. Cada archivo se llama
  `<número>_<lote>`, por ejemplo `001_LOTE-2026-001.pdf`.
- **CSV:** número, URL permanente, lote, diseño, estado, negocio, destino (separado por `;` para Excel en español).

Para el **proveedor de impresión**, lo más seguro son los **PDF individuales de 100 × 150 mm** (vectoriales en el QR y
el número) o el ZIP. Para una **impresora común**, imprimí la plancha PDF con **“Tamaño real” / escala 100 %** —
nunca “Ajustar a la página”— y medí la regla de 50 mm.

---

## 5. Asignar unidades a un cliente

Panel → **Negocios** → creá la ficha (nombre, rubro, teléfono, contacto, observaciones, fecha de entrega).
En la ficha → **Asignar plásticos**: escribí los números (`001-010, 015`), opcionalmente la fecha de entrega y el
nuevo estado (reservado, vendido, entregado, activo). Una unidad no puede estar en dos negocios: si alguna ya está
asignada, no se asigna ninguna y se informa cuál.

**Reemplazo por defecto:** en la ficha de la unidad → *Marcar defectuosa y reemplazar*. El reemplazo (una unidad
disponible o una nueva) hereda negocio y destino y queda vinculado a la original.

Estados: Generado, Disponible, Reservado, Vendido, Entregado, Activo, Pausado, Defectuoso, Dado de baja (final).

---

## 6. Cambiar las redirecciones

Desde el panel (botón **Acciones** de cada fila) o desde la ficha de la unidad:

- Tipos de destino: **Reseña en Google** (Place ID → abre “Escribir reseña”), **Google Maps**, **Menú**, **Sitio web**
  o **Página propia** con varios enlaces (mensaje neutral; sin filtrar opiniones por puntuación).
- **Probar destino** consulta el sitio desde el servidor y permite abrirlo en otra pestaña antes de guardar.
- **El QR impreso no cambia nunca**: codifica la URL permanente de tu dominio y el servidor redirige (302, sin caché)
  al destino actual.
- El QR **solo redirige en estado “Activo”**. Pausado muestra “temporalmente no disponible”; dado de baja, “ya no está
  en uso”; sin activar, “todavía no está activado”.
- Solo se aceptan destinos `https://` públicos (sin IP privadas, sin credenciales, sin `javascript:`, sin bucles).
- Cada cambio queda en el historial con fecha, administrador y nota.

---

## 7. Estadísticas

Se registran **escaneos** (apertura del QR) y **clics** (enlaces de una página propia), por unidad, por negocio y por
período. No se guardan IP, navegador ni datos del teléfono. Las **reseñas publicadas no se pueden medir** desde el QR
(Google no informa qué escaneo terminó en una reseña); el panel lo indica en lugar de inventar un número.

---

## 8. Seguridad y datos

- Contraseñas con **scrypt** (sal aleatoria). El primer administrador solo se crea por consola.
- Sesión en cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` con HTTPS), token CSRF y verificación de origen.
- Límite de intentos de ingreso. Todas las rutas `/admin` y `/api` exigen sesión; lo único público es `/q/...`.
- Validación de todas las entradas en el servidor; consultas SQL parametrizadas; HTML escapado; cabeceras de
  seguridad (CSP, etc.); CSV protegido contra inyección de fórmulas.
- **Inmutabilidad en la base:** triggers impiden borrar unidades o lotes, cambiar número/URL/QR de una unidad o
  reactivar una unidad dada de baja.
- **Numeración transaccional** (`BEGIN IMMEDIATE`): probada con 20 pedidos simultáneos y 4 procesos a la vez.
- Registro de acciones (login, lotes, cambios, exportaciones, copias) en *Registro y copias*.
- Copias de seguridad desde el panel o `npm run backup`, y automática antes de cada migración.

---

## 9. Antes de publicar en internet

1. **Dominio definitivo:** en `.env`, `PUBLIC_BASE_URL=https://qr.tu-dominio.com`. Se graba en cada QR al generarlo y
   **no cambia después**: definilo antes del primer lote real. (Mientras sea `localhost` el panel avisa “Modo prueba”
   y exige confirmar que el lote es de prueba.)
2. **Servidor con HTTPS:** un VPS o servicio con disco persistente (la base es un archivo; no sirven plataformas
   sin disco persistente). Delante, un proxy con certificado (Caddy, Nginx, Cloudflare). Configurá `HOST=0.0.0.0` si
   el proxy está en otra máquina, `TRUST_PROXY=true` y dejá `COOKIE_SECURE=auto`.
3. **Mantener el dominio para siempre:** si el dominio deja de funcionar, los plásticos impresos dejan de funcionar.
4. **Copias fuera del servidor:** programá `npm run backup` (Programador de tareas de Windows o cron) y copiá la
   carpeta `backups` a otro lugar.
5. **Prueba física:** imprimí un lote de prueba, medí 10 × 15 cm y escaneá con varios celulares.
6. Uso de marcas: el diseño incluye el logo de Google; verificá que su uso cumpla las pautas de marca de Google.

---

## 10. Pruebas

`npm test` ejecuta 22 pruebas (Node test runner). Usan una **imagen sintética** generada en el momento
(`test/fixtures/make-fixture.js`, rotulada “FIXTURE DE PRUEBA”) con la misma geometría del plástico, porque el
archivo original no estaba disponible. Cubren:

1. Generación de 1 unidad · 2. 100 unidades consecutivas · 3. Sin números ni URL duplicados · 4. Cada QR (PNG/PDF/SVG)
decodifica la URL de su propio registro · 5. En la plancha rasterizada, el QR de cada posición es el de la unidad cuyo
número va debajo · 6. Sustitución del QR original (queda tapado e ilegible) · 7. Legibilidad de los QR · 8. Exportación
PNG, PDF, SVG, ZIP y CSV · 9. PDF individuales de 100,00 × 150,00 mm y diseños sin recortar ni escalar en la plancha ·
10. Cambio de destino sin cambio del QR · 11. Persistencia tras reiniciar el servidor · 12. Panel protegido (401/302,
CSRF, origen, cookies) — además de concurrencia, formato ≥ 1000, exclusividad de asignación, reemplazos, validación de
destinos y entradas maliciosas.

La lectura del QR en la plancha impresa usa `pdftoppm` (Poppler); si no está instalado (habitual en Windows), esa
parte se omite y se informa.

---

## Estructura

```
src/
  server.js, app.js, config.js, db.js, util.js
  migrations/001_inicial.sql      esquema, contadores y triggers de inmutabilidad
  services/  numbering.js (numeración y lotes) · render.js (PNG/SVG/PDF/planchas) · designs.js (plantillas,
             detección y verificación) · units.js · businesses.js · destinations.js · stats.js · auth.js ·
             audit.js · backup.js
  routes/    api.js (panel) · public.js (/q/:id)
public/      login, páginas del panel (admin/) y estilos (static/)
scripts/     crear-admin.js · backup.js · migrar.js · prueba-diseno.js
test/        pruebas automáticas y generador de la imagen sintética
assets/fonts DejaVu Sans (licencia en LICENSE-DejaVu.txt) para los números
```
