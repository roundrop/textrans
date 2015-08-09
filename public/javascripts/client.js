var socket = io.connect();

socket.on('connect', function() {
  socket.emit('init');
});

socket.on('init', function(keycode) {
  $('#loading').hide();
  $('#your_keycode').html(keycode);
});

socket.on('err push', function(msg) {
  $('#error_info').html(msg);
  $('#error').show();
});

socket.on('msg push', function(msg) {
  $('.alert').hide();
  $('#error').hide();
  $('#pushed_content').show();
  var $func = $('#func');
  $func.children().remove();
  $('#pushed_text').val(msg).select();
  var url = msg.match(/(http|https):\/\/[-_.!~*¥'()a-zA-Z0-9;¥/?:¥@&=+¥$,%#]+/);
  if (url !== null) {
    $func
    .append('<button id="openurl" class="form-control input-lg">Open URL</button>')
    .unbind('click')
    .click(function() {window.open(url[0]); return false; })
    .css('cursor', 'pointer');
  }
  var e = document.getElementById('pushed_text');
  setTimeout(function() {
    e.setSelectionRange(0, 9999);
  }, 1);
  _gaq.push(['_trackPageview', '/r/']);
  socket.disconnect();
  socket.connect();
});

$(function() {
  $('#form').submit(function() {
    var message = $('#message').val();
    var keycode = $('#keycode').val();
    if (!message || !keycode) {return false; }
    socket.emit('msg send', message, keycode);
    $('#error').hide();
    _gaq.push(['_trackPageview', '/s/']);
    return false;
  });
});