const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

let port = null;

function startSerialMonitor(portPath = "COM5", baud = 115200, io) {

  port = new SerialPort({
    path: portPath,
    baudRate: baud
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

  parser.on("data", line => {
    console.log("ESP32:", line);

    if (io) {
      io.emit("serial-data", line);
    }
  });

  port.on("error", err => {
    console.error("Serial error:", err);
  });

}

module.exports = { startSerialMonitor };