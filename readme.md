# scrpr

scrpr is a lightweight scraper multitool. it can fetch data via https, detect changes and parse the most common formats.

## Usage Example

```javascript
const scrpr = require("scrpr");

const scraper = scrpr({
	concurrency: 5,
	cachedir: '/tmp/scraper-cache',
});


scraper("https://example.org/data.csv", { 
	parse: "csv", 
}, function(err, change, data){

	if (err) console.error(err);
	if (change) console.log(data);
	
});
```

### `scrpr(opts)` → *function scraper*

Constructor, returns scraper function

Opts:
* `concurrency` — number of parallel requests; default: `1`
* `cachedir` — directory to save cache data in; default: `<root module>/.scrpr-cache`

### `scraper([url], [opts], [callback(err, change, data)])`

Scraper, delivers data

Opts:
* `method` — http method; default: `get`
* `url` — URL, alternative to `url` parameter
* `headers` — additional http headers, default: `{}`
* `data` — http data, default: `null`
* `cache` — use cache, default: `true`
* `cacheid` — override cache id, default: `hash(url, opts)`
* `parse` — format to parse, default: `null` (raw data)
* `successCodes` — array of http status codes considered successful, default: `[ 200 ]`
* `needle` — options passed on to `needle`, default `{}`
* `pdf` — options passed on to `pdf.js-extract`, default `{}`

Callback:
* `err` — contains Error or `null`
* `change` — `true` if data changed
* `data` — raw or parsed data when changed, otherwise status string

## Parsers

* `csv` — Comma Seperated Values; `data` is an Object, parsed with [xsv](https://npmjs.com/package/xsv)
* `tsv` — Tab Separated Values; `data` is an Object, parsed with [xsv](https://npmjs.com/package/xsv)
* `ssv` — Semicolon Separated Values (data has been exported "as csv" with some localizations of Microsoft Excel): `data` is an Object, parsed with [xsv](https://npmjs.com/package/xsv)
* `xml` — eXtensible Markup Language; `data` is an Object, parsed with [xml2js](https://npmjs.com/package/xml2js)
* `json` — JavaScript object Notation; `data` is an Object, parsed natively by [needle](https://npmjs.com/package/needle)
* `html` — HyperText Markup Language; `data` is an instance of [cheerio](https://npmjs.com/package/cheerio)
* `yaml` — YAML Ain't Markup Language; `data` is an Object, parsed with [yaml](https://npmjs.com/package/yaml)
* `xlsx` — Office Open XML Workbook; `data` is an Object, parsed with [xlsx](https://npmjs.com/package/xlsx); `{ "<sheetname>": [ [ cell, cell, cell, ... ], ... ] }`
* `pdf` — Portable Document Format; `data` is an Object, parsed with [pdf.js-extract](https://npmjs.com/package/pdf.js-extract);

## Optional dependencies

`xsv`, `xlsx`, `xml2js`, `yaml` and `pdf.js-extract` are optional dependencies. They should be installed if their parsing is required.


## License

[UNLICENSE](UNLICENSE)

