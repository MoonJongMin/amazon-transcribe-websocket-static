const audioUtils        = require('./audioUtils');  // for encoding audio data as PCM
const crypto            = require('crypto'); // tot sign our pre-signed URL
const v4                = require('./aws-signature-v4'); // to generate our pre-signed URL
const marshaller        = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node    = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const mic               = require('microphone-stream'); // collect microphone input as a stream of raw bytes
const AWS               = require("aws-sdk");

// our converter between binary event streams messages and JSON
const eventStreamMarshaller = new marshaller.EventStreamMarshaller(util_utf8_node.toUtf8, util_utf8_node.fromUtf8);

// our global variables for managing state
let sourceLanguageCode;
let region;
let sampleRate;
let inputSampleRate;
let transcription = "";
let socket;
let micStream;
let socketError = false;
let transcribeException = false;
let translate;
let translation = "";

// check to see if the browser allows mic access
if (!window.navigator.mediaDevices.getUserMedia) {
    // Use our helper method to show an error on the page
    showError('We support the latest versions of Chrome, Firefox, Safari, and Edge. Update your browser and try your request again.');

    // maintain enabled/distabled state for the start and stop buttons
    toggleStartStop();
}

$('#start-button').click(function () {
    $('#error').hide(); // hide any existing errors
    toggleStartStop(true); // disable start and enable stop button

    // set the language and region from the dropdowns
    setSourceLanguage();
    setRegion();

    // Translate 를 위해서 아래 추가
    AWS.config.credentials = new AWS.Credentials($('#access_id').val(), $('#secret_key').val());
    AWS.config.update({"region": $('#region').find(':selected').val()});
    translate = new AWS.Translate();

    // first we get the microphone input from the browser (as a promise)...
    window.navigator.mediaDevices.getUserMedia({
            video: false,
            audio: true
        })
        // ...then we convert the mic stream to binary event stream messages when the promise resolves 
        .then(streamAudioToWebSocket) 
        .catch(function (error) {
            showError('There was an error streaming your audio to Amazon Transcribe. Please try again.');
            toggleStartStop();
        });
});

let streamAudioToWebSocket = function (userMediaStream) {
    //let's get the mic input from the browser, via the microphone-stream module
    micStream = new mic();

    micStream.on("format", function(data) {
        inputSampleRate = data.sampleRate;
    });

    micStream.setStream(userMediaStream);

    // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
    // via Query Parameters. Learn more: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    let url = createPresignedUrl();

    //open up our WebSocket connection
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    let sampleRate = 0;

    // when we get audio data from the mic, send it to the WebSocket if possible
    socket.onopen = function() {
        micStream.on('data', function(rawAudioChunk) {
            // the audio stream is raw audio bytes. Transcribe expects PCM with additional metadata, encoded as binary
            let binary = convertAudioToBinaryMessage(rawAudioChunk);

            if (socket.readyState === socket.OPEN)
                socket.send(binary);
        }
    )};

    // handle messages, errors, and close events
    wireSocketEvents();
}

function setSourceLanguage() {
    sourceLanguageCode = $('#sourceLanguage').find(':selected').val();
    if (sourceLanguageCode == "en-US" || sourceLanguageCode == "es-US")
        sampleRate = 44100;
    else
        sampleRate = 8000;
}

function setRegion() {
    region = $('#region').find(':selected').val();
}

function wireSocketEvents() {
    // handle inbound messages from Amazon Transcribe
    socket.onmessage = function (message) {
        //convert the binary event stream message to JSON
        let messageWrapper = eventStreamMarshaller.unmarshall(Buffer(message.data));
        let messageBody = JSON.parse(String.fromCharCode.apply(String, messageWrapper.body));
        if (messageWrapper.headers[":message-type"].value === "event") {
            handleEventStreamMessage(messageBody);
        }
        else {
            transcribeException = true;
            showError(messageBody.Message);
            toggleStartStop();
        }
    };

    socket.onerror = function () {
        socketError = true;
        showError('WebSocket connection error. Try again.');
        toggleStartStop();
    };
    
    socket.onclose = function (closeEvent) {
        micStream.stop();
        
        // the close event immediately follows the error event; only handle one.
        if (!socketError && !transcribeException) {
            if (closeEvent.code != 1000) {
                showError('</i><strong>Streaming Exception</strong><br>' + closeEvent.reason);
            }
            toggleStartStop();
        }
    };
}

let handleEventStreamMessage = function (messageJson) {
    let results = messageJson.Transcript.Results;

    if (results.length > 0) {
        if (results[0].Alternatives.length > 0) {
            let transcript = results[0].Alternatives[0].Transcript;

            // fix encoding for accented characters
            transcript = decodeURIComponent(escape(transcript));
            // update the textarea with the latest result
            $('#transcript').val(transcription + transcript + "\n");
            if (results[0].IsPartial) {
                doTranslate(transcript, true);
            } else {
            // if this transcript segment is final, add it to the overall transcription
                //scroll the textarea down
                $('#transcript').scrollTop($('#transcript')[0].scrollHeight);
                transcription += transcript + "\n";
                doTranslate(transcript, false);
            }
        }
    }

}

let closeSocket = function () {
    if (socket.readyState === socket.OPEN) {
        micStream.stop();

        // Send an empty frame so that Transcribe initiates a closure of the WebSocket after submitting all transcripts
        let emptyMessage = getAudioEventMessage(Buffer.from(new Buffer([])));
        let emptyBuffer = eventStreamMarshaller.marshall(emptyMessage);
        socket.send(emptyBuffer);
    }
}

$('#stop-button').click(function () {
    closeSocket();
    toggleStartStop();
});

$('#reset-button').click(function (){
    $('#transcript').val('');
    transcription = '';
    $('#translation').val('');
    translation = '';
});

function toggleStartStop(disableStart = false) {
    $('#start-button').prop('disabled', disableStart);
    $('#stop-button').attr("disabled", !disableStart);
}

function showError(message) {
    $('#error').html('<i class="fa fa-times-circle"></i> ' + message);
    $('#error').show();
}

function convertAudioToBinaryMessage(audioChunk) {
    let raw = mic.toRaw(audioChunk);

    if (raw == null)
        return;

    // downsample and convert the raw audio bytes to PCM
    let downsampledBuffer = audioUtils.downsampleBuffer(raw, inputSampleRate, sampleRate);
    let pcmEncodedBuffer = audioUtils.pcmEncode(downsampledBuffer);

    // add the right JSON headers and structure to the message
    let audioEventMessage = getAudioEventMessage(Buffer.from(pcmEncodedBuffer));

    //convert the JSON object + headers into a binary event stream message
    let binary = eventStreamMarshaller.marshall(audioEventMessage);

    return binary;
}

function getAudioEventMessage(buffer) {
    // wrap the audio data in a JSON envelope
    return {
        headers: {
            ':message-type': {
                type: 'string',
                value: 'event'
            },
            ':event-type': {
                type: 'string',
                value: 'AudioEvent'
            }
        },
        body: buffer
    };
}

function createPresignedUrl() {
    let endpoint = "transcribestreaming." + region + ".amazonaws.com:8443";

    // get a preauthenticated URL that we can use to establish our WebSocket
    return v4.createPresignedURL(
        'GET',
        endpoint,
        '/stream-transcription-websocket',
        'transcribe',
        crypto.createHash('sha256').update('', 'utf8').digest('hex'), {
            'key': $('#access_id').val(),
            'secret': $('#secret_key').val(),
            'sessionToken': $('#session_token').val(),
            'protocol': 'wss',
            'expires': 15,
            'region': region,
            'query': "language-code=" + sourceLanguageCode + "&media-encoding=pcm&sample-rate=" + sampleRate
        }
    );
}

function doTranslate(text, isPartial) {
    // console.log("Translation called.")
    // var inputText = $('#transcript').value;
    // console.log("inputText: " + inputText);
    if (!text) {
        // console.log("doTranslate doesn't work!");
        return;
    }
    // console.log("transcription: " + transcription);

    // get the language codes
    let sourceLanguageCode = $('#sourceLanguage').find(':selected').val();
    // Transcribe 은 en-US 와 같은 형식이지만 Translate 는 en, ko 라고만 해야 한다.
    sourceLanguageCode = sourceLanguageCode.substring(0, 2);
    // console.log("sourceLanguageCode: " + sourceLanguageCode);
    let targetLanguageCode = $('#targetLanguage').find(':selected').val();
    targetLanguageCode = targetLanguageCode.substring(0, 2);
    // console.log("targetLanguageCode: " + targetLanguageCode);
    let params = {
        Text: text,
        SourceLanguageCode: sourceLanguageCode,
        TargetLanguageCode: targetLanguageCode
    };

    // let region = $('#region').find(':selected').val();
    // console.log("region: " + region);
    // AWS.config.credentials = new AWS.Credentials("access key", "secret key");
    // $('#access_id').val()
    // $('#secret_key').val()
    // AWS.config.update({"region": region});

    translate.translateText(params, function(err, data) {
        if (err) {
            console.log(err, err.stack);
            alert("Error calling Amazon Translate. " + err.message);
            return;
        }
        if (data) {
            // console.log("TranslatedText: " + data.TranslatedText);
            /* 가끔 Translation 에 같은 번역 문장이 2줄 display 되는 경우가 있는데 그 이유가 문장이 완료되는 경우 위에서 doTranslate(text, true) 를 호출하고
             * isPartial 이 false 여서 doTranslate(text, false) 도 즉시 호출될 경우 비동기로 수행되면서 doTranslate(text, false) 가 먼저 완료되어 버려서
             * translation 에 번역내용이 같이 포함된 상태에서 다시 doTranslate(text, true) 부분을 출력해서 이런 현상이 발생했다.
             * 이 문제는 153 라인에서 isPartial 로 구분해서 translate 를 호출할 경우 문장 완료 여부에 관계 없이 같은 번역대상 text 로
             * doTranslate(text,true), doTranslate(text,false) 가 동시에 2번 호출되지 않도록 해서 방어? 그래도 안되는 것이 같은 transcription 으로
             * results[0].IsPartial 값이 true 이다가 문자 완료 인식해서 false 로 다시 한번 더 호출되나 보다...
             * 꼼수로 약간의 시간 delay 를 준다.
             */
            $('#translation').val(translation + data.TranslatedText + "\n");
            // isPartial 이 아니면 (즉, 완료된 문장이면) 전체 translation 에 추가
            if(!isPartial) {
                //scroll the textarea down
                $('#translation').scrollTop($('#translation')[0].scrollHeight);
                // 100ms delay 를 주는 이유는 위 주석 참고...
                setTimeout(() => translation += data.TranslatedText + "\n", 100);
                // translation += data.TranslatedText + "\n";
            }
        }
    });
}
