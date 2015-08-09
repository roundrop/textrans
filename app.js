/* vars */
var HashMap = require('hashmap');

var express = require('express');
var app = express();
var http = require('http').Server(app);

var path = require('path');
var bodyParser = require('body-parser');
var io = require('socket.io')(http);
var i18n = require('i18n');

var map = new HashMap();

/* setup */
i18n.configure({
  'locales': ['en', 'ja'],
  'directory': path.join(__dirname, '/locales')
});

app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('view options', {'layout': false});
app.use(bodyParser.urlencoded({'extended': false}));
app.use(i18n.init);

/* http */
app.get('/', function(req, res) {
  res.render('index');
});
http.listen(process.env.PORT || 3000);

/* socket.io */
io.sockets.on('connection', function(socket) {
  socket.on('init', function() {
    var keycode = generateKeycode();
    map.set(keycode, socket.id);
    socket.emit('init', keycode);
  });

  socket.on('msg send', function(msg, keycode) {
    if (msg.length > 20000) {
      socket.emit('err push', 'text too large');
      return;
    }
    var targetId = map.get(keycode);
    if (typeof targetId === 'undefined') {
      socket.emit('err push', 'Invalid Keycode');
    } else {
      socket.to(targetId).emit('msg push', msg);
    }
  });

  socket.on('disconnect', function() {
    clearKeycode(socket.id);
  });
});

/* functions */
function generateKeycode() {
  var keycode = ('000' + Math.floor(Math.random() * 9999 + 1)).slice(-4);
  while (map.has(keycode)) {
    keycode = generateKeycode();
  }
  return keycode;
}

function clearKeycode(socketid) {
  var keycode = map.search(socketid);
  map.remove(keycode);
}