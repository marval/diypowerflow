//*********************
// BASIC configuration
const mqtt_host = "10.0.0.20";
const influx_host = "10.0.0.20";

//**********************************************
// Solar prediction configuration
// for this to work, you must enter correct values for your location and panel configuration
const latitude = 55.84180;
const longitude = 9.83141;
const msl = 36; // Mean sea level (in meters)
//
const panels_cfg = [
  // azimuth: in degrees (direction along the horizon, measured from south to west), e.g. 0 is south and 90 is west
  // angle: angle the panels are facing relative to the horizon in degrees, e.g. 0 they are vertical, 90 they are flat
  // wattPeak: the Wp of the panels
  {
    name: 'Roof',
    azimuth: 7,
    angle: 35,
    wattPeak: 4500
  }
];
// API key for darksky.net, in order to use aditionally forecasr from darksky.net you need to get and enter an API key
const darkskyApi = 'e0d5e84d87bc266e4bfc47c611881574';

// the final calculated prediction will use weighted average from yr and darksky
// these are the weights for each forecast service, the sum should be 1.0
// adjust to fit which service better forecasts your location
//
const yr_weight = 0.4;
const darsksky_weight = 0.6;


//**************************************************
// Influx kWh queries
const timezone = "Europe/Copenhagen";
//const house_kwh_query = "SELECT sum(kwh) as kwh FROM energy WHERE (device = 'house' OR device= 'house2') AND time > now() - 1d GROUP BY time(1d) fill(0) TZ('"+timezone+"')";
//const house_kwh_query = "SELECT sum(kwh) as kwh FROM energy WHERE (device = 'house' OR device= 'house2') AND time > now() - 1d GROUP BY time(1d) fill(0) TZ('"+timezone+"')";
//const house_kwh_query = "select sum(wh)/1000 as kwh from (select watt/60 as wh from(select MEAN(ac_output_active_power) as watt FROM solar WHERE time > now() - 1d GROUP BY time(60s) fill(null) TZ('" + timezone + "') )) group by time(1d) fill(0) TZ('" + timezone + "')";
const house_kwh_query = "SELECT difference(last(energy)) as wh FROM pzem WHERE location = 'pzem_output' AND time > now() - 1d GROUP BY time(1d) fill(0) TZ('" + timezone + "')";

const grid_kwh_query = "SELECT difference(last(energy)) as wh FROM pzem WHERE (location = 'pzem_intput') AND time > now() - 1d GROUP BY time(1d) fill(0) TZ('" + timezone + "')";
//const grid_kwh_query = "SELECT sum(kwh) as kwh FROM energy WHERE (device = 'sdm120') AND time > now() - 1d GROUP BY time(1d) fill(0) TZ('"+timezone+"')"
const solar_kwh_query = "select sum(wh)/1000 as kwh from (select watt/60 as wh from(SELECT MEAN(battery_voltage)*MEAN(pv_input_current_for_battery)*1.03 as watt FROM solar WHERE time > now() - 1d GROUP BY time(60s) fill(null) TZ('" + timezone + "') )) group by time(1d) fill(0) TZ('" + timezone + "')";

const powerwall_soc_query = "SELECT last(ShuntSOC),last(DailySessionCumulShuntkWhDischg),last(DailySessionCumulShuntkWhCharge) FROM generic";

//**************************************************
// MQTT watt topics
//const house_watt_topic = 'solar/output';
const house_watt_topic = 'pzem/output';
const grid_watt_topic = 'pzem/input';
const powerwall_watt_topic = 'Batrium/6687/3e32';
const solar_watt_topic = "solar/solar";


//**************************************************
//**************************************************

const express = require('express')
const app = express()
const diy_sun = require('./diy_sun');

const mqtt = require('mqtt')
const mqtt_client = mqtt.connect('mqtt://' + mqtt_host);

const Influx = require('influx')
const influx = new Influx.InfluxDB({
  host: influx_host,
  database: 'solar'
})

const influx_batrium = new Influx.InfluxDB({
  host: influx_host,
  database: 'batrium',
  schema: [
    {
      measurement: 'prediction',
      tags: ['source'],
      fields: {
        production: Influx.FieldType.FLOAT
      }
    }
  ]
})



var moment = require('moment');
var schedule = require('node-schedule');


var house = 0;
var house2 = 0;
var grid = 0;
var powerwall = 0;
var solar = 0;
var solar_prediction = 0;
var solar_prediction_dayOffset = 0;

var server = require('http').createServer(app);
var io = require('socket.io')(server);
var SunCalc = require('suncalc');

function emitSolarPrediction() {
  prefix = "";

  if (solar_prediction_dayOffset > 0) {
    prefix = "tomorrow ";
  }

  io.emit('solar prediction', { message: "(" + prefix + "prediction " + solar_prediction.toPrecision(2) + " kWh)" });
}

function calculateSolarPrediction() {
  return diy_sun.solar_prediction_kwh(panels_cfg, solar_prediction_dayOffset, latitude, longitude, msl, darkskyApi, yr_weight, darsksky_weight);
}

// schedule every night to recalculate solar prediction for current day and schedule a job for the sunset

var j1 = schedule.scheduleJob('0 2 * * *', function () {

  solar_prediction_dayOffset = 0;
  solar_prediction = calculateSolarPrediction();
  emitSolarPrediction();
  calculatePredictions();

  var j2 = schedule.scheduleJob(moment(SunCalc.getTimes(moment(), latitude, longitude).sunset).toDate(), function () {
    // at sunset recalculate solar prediction for tomorrow
    solar_prediction_dayOffset = 1;
    solar_prediction = calculateSolarPrediction();
    emitSolarPrediction();
    calculatePredictions();
  });

});


console.log("Calculating solar prediction");
solar_prediction_dayOffset = moment().isAfter(moment(SunCalc.getTimes(moment(), latitude, longitude).sunset)) ? 1 : 0;
solar_prediction = calculateSolarPrediction();

io.on('connection', function () {
  //    console.log("NEW CONNECTION sending all values on start");
  if (house > 0) {
    io.emit('house', { message: house });
  }
  if (powerwall != 0) {
    io.emit('powerwall', { message: powerwall });
  }
  if (grid != 0) {
    io.emit('grid', { message: grid });
  }
  if (solar > 0) {
    io.emit('solar', { message: solar });
  }
  if (solar_prediction > 0) {
    emitSolarPrediction();
  }
});

mqtt_client.on('connect', () => {
  //  console.log("MQTT connected");
  mqtt_client.subscribe(house_watt_topic);
  mqtt_client.subscribe(grid_watt_topic);
  mqtt_client.subscribe(powerwall_watt_topic);
  mqtt_client.subscribe(solar_watt_topic);
})

mqtt_client.on("close", function (error) {
  console.log("mqtt can't connect" + error);
  io.emit('house', { message: 0 });
  io.emit('grid', { message: 0 });
  io.emit('powerwall', { message: 0 });
  io.emit('solar', { message: 0 });
})

mqtt_client.on('message', (topic, message) => {
  if (topic === house_watt_topic) {
    //house = parseInt(message.toString())
    house = JSON.parse(message).power;
    io.emit('house', { message: house });
  } else
    if (topic === powerwall_watt_topic) {
      var tmpPowerwall = JSON.parse(message);

      powerwall = Number(tmpPowerwall.ShuntVoltage) * Number(tmpPowerwall.ShuntCurrent);
      io.emit('powerwall', { message: powerwall });
      io.emit('cellVoltages', { minV: tmpPowerwall.MinCellVolt, maxV: tmpPowerwall.MaxCellVolt, avgV: tmpPowerwall.AvgCellVolt })
      io.emit('cellTemps', { minT: tmpPowerwall.MinCellTemp, maxT: tmpPowerwall.MaxCellTemp, avgT: tmpPowerwall.AvgCellTemp })
    } else
      if (topic === grid_watt_topic) {
        grid = JSON.parse(message).power;
        io.emit('grid', { message: grid });
      } else
        if (topic === solar_watt_topic) {
          solar = parseInt(message.toString())
          io.emit('solar', { message: solar });
        }
})

app.get('/energy', function (req, res) {
  influx.query(house_kwh_query).then(house => {
    influx.query(grid_kwh_query).then(grid => {
      influx.query(solar_kwh_query).then(solar => {
        res.json(
          [
            { "name": "grid kwh", "value": (grid === undefined || grid.length == 0) ? 0 : grid[1].wh / 1000 },
            { "name": "house kwh", "value": house[1].wh / 1000 },
            { "name": "solar kwh", "value": solar[solar.length - 1].kwh }
          ]
        );
      });
    });
  });
});
//})

app.get('/soc', function (req, res) {
  influx_batrium.query(powerwall_soc_query).then(soc => {
    res.json(
      [
        { "name": "powerwall soc", "value": { 'soc': soc[0].last, 'charge_kwh': soc[0].last_2, 'discharge_kwh': soc[0].last_1 } }
      ]
    );
  });
})


app.get('/predictions', function (req, res) {
  console.log('calculating');
  var result = calculatePredictions();
  res.json(result);
})

function calculatePredictions(_daysForward = 3) {
  function calculateSolarPredictionLocal(_yrWeight, _darkSkyWeight, _dayOffset) {
    return diy_sun.solar_prediction_kwh(panels_cfg, _dayOffset, latitude, longitude, msl, darkskyApi, _yrWeight, _darkSkyWeight);
  }

  var result = {
    'darkSky': [],
    'yr': []
  }

  var today = new moment();
  var daysForward = _daysForward;
  var points = [];
  for (let index = 0; index < daysForward; index++) {
    var day = today.add(index, 'days');
    result.darkSky.push({
      'day': day.format(),
      'value': calculateSolarPredictionLocal(0, 1, index)
    })
    points.push(
      {
        measurement: 'prediction',
        fields: {
          production: result.darkSky[index].value,
        },
        tags: {
          source: 'darksky'
        },
        timestamp: day.unix() + '000000000'
      });
    result.yr.push({
      'day': day.format(),
      'value': calculateSolarPredictionLocal(1, 0, index)
    })
    points.push(
      {
        measurement: 'prediction',
        fields: {
          production: result.yr[index].value,
        },
        tags: {
          source: 'yr'
        },
        timestamp: day.unix() + '000000000'
      });
  }

  console.log(points);

  influx_batrium.writePoints(points).catch(err => {
    console.error('Error writing to InfluxDB', err)
  })

  return result;
}


app.use(express.static('static'))

server.listen(3333, () => console.log('DIY powerflow listening on port 3333!'))
