goog.module('plugin.vectortile.VectorTileLayerConfig');

const log = goog.require('goog.log');

const {DEFAULT_MAX_ZOOM, DEFAULT_MIN_ZOOM} = goog.require('ol');
const olColor = goog.require('ol.color');
const olExtent = goog.require('ol.extent');
const VectorTileRenderType = goog.require('ol.layer.VectorTileRenderType');
const {transformExtent} = goog.require('ol.proj');
const Style = goog.require('ol.style.Style');

const Settings = goog.require('os.config.Settings');
const DisplaySetting = goog.require('os.config.DisplaySetting');
const osColor = goog.require('os.color');
const VectorTileLayer = goog.require('os.layer.VectorTile');
const osMap = goog.require('os.map');
const VectorTileSource = goog.require('os.ol.source.VectorTile');
const AbstractLayerConfig = goog.require('os.layer.config.AbstractLayerConfig');
const AbstractTileLayerConfig = goog.require('os.layer.config.AbstractTileLayerConfig');
const net = goog.require('os.net');
const CrossOrigin = goog.require('os.net.CrossOrigin');
const Request = goog.require('os.net.Request');
const {addProxyWrapper, autoProxyCheck} = goog.require('os.ol.source.tileimage');
const {getBestSupportedProjection, EPSG4326} = goog.require('os.proj');
const StyleManager = goog.require('os.style.StyleManager');
const {DEFAULT_FONT} = goog.require('os.style.label');
const {getVectorTileFormat, VectorTileFormat} = goog.require('plugin.vectortile.format');

const Projection = goog.requireType('ol.proj.Projection');
const OLVectorTileSource = goog.requireType('ol.source.VectorTile');


/**
 * Logger
 * @type {log.Logger}
 */
const logger = log.getLogger('plugin.vectortile.VectorTileLayerConfig');


/**
 * Get fonts supported by the application.
 * @param {Array<string>} fonts The style fonts.
 * @return {Array<string>} The supported fonts.
 */
const getFonts = (fonts) => {
  const defaultLC = DEFAULT_FONT.toLowerCase();
  const supported = fonts.filter((f) => !!f && f.toLowerCase().indexOf(defaultLC) > -1);
  if (!supported.length) {
    supported.push(DEFAULT_FONT);
  }

  return supported;
};


/**
 */
class VectorTileLayerConfig extends AbstractLayerConfig {
  /**
   * Constructor.
   */
  constructor() {
    super();

    /**
     * @type {?CrossOrigin}
     * @protected
     */
    this.crossOrigin = null;

    /**
     * @type {Projection}
     * @protected
     */
    this.projection = null;

    /**
     * List of URLs for load balancing.
     * @type {Array<string>}
     * @protected
     */
    this.urls = [];
  }

  /**
   * @inheritDoc
   */
  initializeConfig(options) {
    super.initializeConfig(options);

    if (options['urls'] != null) {
      this.urls = /** @type {!Array<string>} */ (options['urls']);
    } else if (this.url) {
      // make sure the "urls" property is set in the options for multiple URL support
      this.urls = [this.url];
    }

    // remove URL properties so they can be set manually on the source when ready to load
    options['url'] = undefined;
    options['urls'] = undefined;

    this.expandUrls();

    const projection = getBestSupportedProjection(options);
    if (!projection) {
      throw new Error('No projections supported by the layer are defined!');
    }

    this.projection = projection;

    // cross origin
    if (!net.isValidCrossOrigin(options['crossOrigin'])) {
      this.crossOrigin = /** @type {CrossOrigin} */ (net.getCrossOrigin(this.urls[0]));
    } else {
      this.crossOrigin = /** @type {CrossOrigin} */ (options['crossOrigin']);

      for (let i = 0; i < this.urls.length; i++) {
        const url = this.urls[i];

        // register the cross origin value by URL pattern so that our Cesium.loadImage mixin can find it
        net.registerCrossOrigin(AbstractTileLayerConfig.getUrlPattern(url), this.crossOrigin);
      }
    }

    // the correct none equivalent for crossOrigin in OL is null
    if (this.crossOrigin === CrossOrigin.NONE) {
      this.crossOrigin = null;
      options['crossOrigin'] = null;
    }

    // Default declutter to true to avoid label collision.
    if (options['declutter'] !== false) {
      options['declutter'] = true;
    }

    // Default render mode to 'image'
    if (!options['renderMode']) {
      options['renderMode'] = VectorTileRenderType.IMAGE;
    }

    // If zoom levels aren't specified, assume vector tiles can be generated at all levels
    if (options['minZoom'] == null) {
      options['minZoom'] = DEFAULT_MIN_ZOOM;
    }

    if (options['maxZoom'] == null) {
      options['maxZoom'] = DEFAULT_MAX_ZOOM;
    }
  }

  /**
   * @param {Object<string, *>} options The options
   * @return {VectorTileSource}
   */
  getSource(options) {
    // Copy the original options to avoid adding a non-serializable object to it.
    const sourceOptions = /** @type {olx.source.VectorTileOptions} */ (Object.assign({}, options));

    const vtFormat = /** @type {VectorTileFormat|undefined} */ (sourceOptions['format']);
    sourceOptions.format = getVectorTileFormat(vtFormat || VectorTileFormat.MVT);

    return new VectorTileSource(sourceOptions);
  }

  /**
   * @param {OLVectorTileSource} source The source
   * @param {Object<string, *>} options The options
   * @return {VectorTileLayer}
   */
  getLayer(source, options) {
    const vectorTileOptions = /** @type {olx.source.VectorTileOptions} */ (Object.assign({}, options));
    vectorTileOptions.source = source;

    const layerClass = /** @type {!Function} */ (options['layerClass'] || VectorTileLayer);
    return new layerClass(vectorTileOptions);
  }

  /**
   * @inheritDoc
   */
  createLayer(options) {
    this.initializeConfig(options);

    const source = this.getSource(options);

    // The extent is set on the source and not the layer in order to properly support wrap-x.
    // See urltilemixin.js for more details.
    if (options['extent']) {
      const extentProjection = /** @type {!string} */ (options['extentProjection']) || EPSG4326;
      const extent = /** @type {ol.Extent} */ (options['extent']);
      source.setExtent(transformExtent(extent, extentProjection, this.projection));
    }

    if (options['attributions']) {
      source.setAttributions(/** @type {Array<string>} */ (options['attributions']));
    }

    if (this.crossOrigin && this.crossOrigin !== CrossOrigin.NONE) {
      if (options['proxy']) {
        log.fine(logger, `layer ${this.id} proxy=true`);
        addProxyWrapper(source);
      } else if (options['proxy'] === undefined) {
        log.fine(logger, `layer ${this.id} proxy=auto`);
        autoProxyCheck(source, this.projection);
      }
    }

    log.fine(logger, `layer ${this.id} crossOrigin=${this.crossOrigin}`);

    if (!source.tileLoadSet) {
      source.setTileLoadFunction(source.getTileLoadFunction());
    }

    const layer = this.getLayer(source, options);
    layer.restore(options);

    if (options['styleUrl'] && options['sources']) {
      new Request(/** @type {string} */ (options['styleUrl'])).getPromise()
          .then((resp) => {
            return /** @type {!MapboxStyle} */ (JSON.parse(resp));
          })
          .then((glStyle) => {
            const sources = /** @type {string|Array<string>} */ (options['sources']);

            const mapWidth = olExtent.getWidth(osMap.PROJECTION.getExtent());
            const maxZoom = /** @type {number} */ (options['maxZoom'] || osMap.MAX_ZOOM);

            const resolutions = [];
            for (let resolution = mapWidth / 512; resolutions.length < maxZoom; resolution /= 2) {
              resolutions.push(resolution);
            }

            const glStyleFunction = parseMapboxStyle(glStyle, sources, resolutions, getFonts);

            /**
             * @param {ol.Feature|ol.render.Feature} feature
             * @param {number} resolution
             * @return {ol.style.Style|Array<ol.style.Style>}
             */
            const styleFunction = (feature, resolution) => {
              let styleConfig = glStyleFunction(feature.getProperties(), feature.getGeometry().getType(), resolution);
              if (styleConfig) {
                if (Array.isArray(styleConfig)) {
                  if (styleConfig.length === 1) {
                    styleConfig = styleConfig[0];
                  } else {
                    styleConfig = Object.assign(...styleConfig);
                  }
                }

                const sm = StyleManager.getInstance();
                const featureStyle = sm.getOrCreateStyle(styleConfig);

                const textConfig = styleConfig['text'];
                if (textConfig) {
                  // if a stroke is not defined, set it to null so a default stroke isn't applied
                  if (!textConfig['stroke']) {
                    textConfig['stroke'] = null;
                  }

                  // create the style using the text reader
                  const reader = sm.getReader('text');
                  if (reader) {
                    const textStyle = reader.getOrCreateStyle(textConfig);
                    const labelStyle = new Style({
                      text: textStyle,
                      zIndex: /** @type {number|undefined} */ (styleConfig['zIndex'])
                    });

                    return [featureStyle, labelStyle];
                  }
                }

                return featureStyle;
              }

              return null;
            };

            layer.setStyle(styleFunction);

            // set URL's on the source and refresh to load the layer
            source.setUrls(this.urls);
            source.refresh();

            if (glStyle.layers) {
              // if the style has a background layer, apply the color to the map/globe
              const bgLayer = glStyle.layers.find((l) => l.type === 'background');
              if (bgLayer && bgLayer.paint) {
                const bgColor = /** @type {string|undefined} */ (bgLayer.paint['background-color']);
                if (bgColor) {
                  const rgbaArray = olColor.fromString(bgColor);
                  Settings.getInstance().set(DisplaySetting.BG_COLOR, osColor.toHexString(rgbaArray));
                }
              }
            }
          })
          .thenCatch((e) => {
            log.error(logger, `layer ${layer.getId()} could not load style from ${options['styleUrl']}`);
          });
    } else {
      source.setUrls(this.urls);
    }

    return layer;
  }

  /**
   * Expand URLs that contain ranges for rotating tile servers.
   * @protected
   */
  expandUrls() {
    this.urls = AbstractTileLayerConfig.expandUrls(this.urls);
  }
}


exports = VectorTileLayerConfig;
