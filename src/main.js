import debug from 'debug'
import { assertThat, isNumber } from './core/asserts.mjs'
import Prometheus from './datasource/prometheus.js'
import fs from 'fs';
import path from 'path';
import commander from 'commander'
import assert from 'assert'
import yaml from 'js-yaml'
import nunjucks from 'nunjucks';

const log = debug('main')
const info = debug('info');
debug.enable('info,' + process.env['DEBUG']);
const program = commander.program;

program.version('1.0.0')
    .description('A tool to take snapshot of Prometheus metric and save as SVG/PNG')
    .option('--since <since>', 'Record metric since last XXX s/m/h/d (seconds/minutes/hours/days), default in seconds')
    .option('--start <time>', 'Record metric started from the given time, in format yyyy-MM-ddThh:mm:ss')
    .option('--end <time>', 'Record metric end at the given time, in format yyyy-MM-ddThh:mm:ss')
    .option('--output <title>', 'The output SVG/PNG file path', './output')
    .option('--metrics <yaml1,yaml2,...>', 'List of paths to the metric file which defined a series of metrics need to be recorded')
    .option('--prometheus <url>', 'The url to Prometheus', 'http://localhost:9090');

program.parse(process.argv);

const options = program.opts();

const { prometheus, output } = options;

const since = options.since !== undefined ? toSeconds(options.since) : undefined;
const metricYaml = options.metrics;

log(`Execute program with options: ${JSON.stringify(options, null, 4)}`)

const startInUnixSeconds = new Date(options.start).getTime() / 1000;
const endInUnixSeconds = new Date(options.end).getTime() / 1000;
const step = 30;

if (metricYaml === undefined) {
    assert.fail("No metric specified. You should set --metrics. Use --help to see more detail.")
}

let directory = path.dirname(output);
if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
}

const prometheusClient = new Prometheus(prometheus);
let graphId = 0;

async function fetchMetrics(graphOptions) {
    const _promql = graphOptions.query;
    log(`Query Prometheus: ${_promql}`);

    let dataSet;
    if (since !== undefined && since > 0) {
        dataSet = await prometheusClient.queryRangeSince(_promql, since, {
            step: step || calculateStep()
        });
        log(`Got data from Prometheus: ${dataSet.length} series are found`);
    } else {
        log(`queryRange: _promql=${_promql}, start=${startInUnixSeconds} end=${endInUnixSeconds}`);
        dataSet = await prometheusClient.queryRange(_promql, startInUnixSeconds, endInUnixSeconds, {
            step: step || calculateStep()
        });
        log(`Got data from Prometheus: ${dataSet.length} series are found`);
    }

    return dataSet;
}

/**
 * @param duration string
 * @returns {number}
 */
function toSeconds(duration) {
    assertThat(duration).isNotBlank();

    const timeUnit = duration.charAt(duration.length - 1);
    if (isNumber(timeUnit)) {
        return parseInt(duration);
    } else {
        assertThat(timeUnit).isOneOf(['s', 'm', 'h', 'd'])
        const time = parseInt(duration.substr(0, duration.length - 1));

        switch (timeUnit) {
            case 's':
                return time;
                break;
            case 'm':
                return time * 60;
                break;
            case 'h':
                return time * 60 * 60;
                break;
            case 'd':
                return time * 60 * 60 * 24;
                break;
            default: {
                assert.fail(`Unsupported time unit ${timeUnit}`);
            }
        }
    }
}

function calculateStep() {
    let _start = startInUnixSeconds;
    let _end = endInUnixSeconds;
    if (since !== null && since !== undefined) {
        _end = Date.now() / 1000;
        _start = _end - since;
    }

    const width = 1024;
    const datapointWidth = 10;
    const duration = _end - _start;
    return duration / width / datapointWidth
}

async function buildGraphsOptions(graphYaml) {
    let thisGraphId = graphId;
    graphId = graphId + 1;

    return {
        name: graphYaml.name,
        id: graphId,
        query: graphYaml.query,
        unit: graphYaml.unit,
        dataset: await fetchMetrics(graphYaml)
    }
}

async function buildSection(sectionYaml) {
    return {
        name: sectionYaml.name,
        graphs: await Promise.all(sectionYaml.graphs.map(buildGraphsOptions))
    };
}

async function buildPage(pageYaml) {
    return {
        name: pageYaml.name,
        sections: await Promise.all(pageYaml.sections.map(buildSection))
    };
}

let pages = await Promise.all(yaml
    .load(fs.readFileSync(metricYaml), 'utf8')
    .map(buildPage));

nunjucks.configure({ autoescape: false });
let renderedHtml = nunjucks.render('src/dashboards.html', { pages: pages, pagesJson: JSON.stringify(pages, null, 0) });

fs.writeFileSync(output, renderedHtml, function (err) {
    if (err) {
        info(err);
    } else {
        info(`file saved @ ${output}. size = ${renderedHtml.length}`);
    }
});
