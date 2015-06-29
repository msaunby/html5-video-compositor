import VideoSource from "./sources/videosource.js";
import ImageSource from "./sources/imagesource.js";
import CanvasSource from "./sources/canvassource.js";


let updateables = [];
let previousTime = undefined;
let mediaSourceMapping = new Map();
mediaSourceMapping.set("video",VideoSource).set("image",ImageSource).set("canvas",CanvasSource);


function registerUpdateable(updateable){
    updateables.push(updateable);
}
function update(time){
    if (previousTime === undefined) previousTime = time;
    let dt = (time - previousTime)/1000;
    for(let i = 0; i < updateables.length; i++){
        updateables[i].update(dt);
    }
    previousTime = time;
    requestAnimationFrame(update);
}
update();


class VideoCompositor {
    constructor(canvas){
        this._canvas = canvas;
        this._ctx = this._canvas.getContext('2d');
        this._playing = false;
        this._mediaSources = new Map();
        this._mediaSourcePreloadNumber = 2; // define how many mediaSources to preload. This is influenced by the number of simultanous AJAX requests available.
        this._playlist = undefined;
        this._eventMappings = new Map();

        this._currentTime = 0;
        this.duration = 0;
        registerUpdateable(this);
    }

    set currentTime(currentTime){
        console.log("Seeking to", currentTime);
        let [toPlay, currentlyPlaying, finishedPlaying] = this._getPlaylistStatusAtTime(this._playlist, currentTime);

        //clean-up any currently playing mediaSources
        this._mediaSources.forEach(function(mediaSource, id, mediaSources){
            mediaSource.destroy();
        });
        this._mediaSources.clear();

        //Load mediaSources
        for (let i = 0; i < currentlyPlaying.length; i++) {
            let mediaSourceID = currentlyPlaying[i].id;
            //If the media source isn't loaded then we start loading it.
            if (this._mediaSources.has(mediaSourceID) === false){
                this._loadMediaSource(currentlyPlaying[i]);
                let mediaSource = this._mediaSources.get(mediaSourceID);

                //Once it's ready seek to the proper place.
                mediaSource.onready=function(){
                    mediaSource.seek(currentTime);
                }
            }else{
               //If the mediaSource is loaded then we seek to the proper bit
                this._mediaSources.get(mediaSourceID).seek(currentTime);
            }

        };

        this._currentTime = currentTime;
        let seekEvent = new CustomEvent('seek', {detail:{data:currentTime, instance:this}});
        this._canvas.dispatchEvent(seekEvent);
    }

    get currentTime(){
        return this._currentTime;
    }
    
    set playlist(playlist){
        VideoCompositor.validatePlaylist(playlist);
        this.duration = VideoCompositor.calculatePlaylistDuration(playlist);
        this._playlist = playlist;
    }

    play(){
        this._playing = true;
        let playEvent = new CustomEvent('play', {detail:{data:this._currentTime, instance:this}});
        this._canvas.dispatchEvent(playEvent);
    }

    pause() {
        this._playing = false;
        this._mediaSources.forEach(function(mediaSource, id, mediaSources){
            mediaSource.pause();
        });
        let pauseEvent = new CustomEvent('pause', {detail:{data:this._currentTime, instance:this}});
        this._canvas.dispatchEvent(pauseEvent);
    }

    addEventListener(type, func){
        //Pass through any event listeners through to the underlying canvas rendering element
        //Catch any events and handle with a custom events dispatcher so things 
        if (this._eventMappings.has(type)){
            this._eventMappings.get(type).push(func);
        }else {
            this._eventMappings.set(type, [func]);
        }
        this._canvas.addEventListener(type, this._dispatchEvents, false);
    }

    _dispatchEvents(evt){
        //Catch events and pass them on, mangling the detail property so it looks nice in the API
        for (let i = 0; i < evt.detail.instance._eventMappings.get(evt.type).length; i++){
            evt.detail.instance._eventMappings.get(evt.type)[i](evt.detail.data);
        }
    }


    _getPlaylistStatusAtTime(playlist, playhead){
        let toPlay = [];
        let currentlyPlaying = [];
        let finishedPlaying = [];

        //itterate tracks
        for(let i = 0; i < playlist.tracks.length; i++){
            let track = playlist.tracks[i];
            for (let j = 0; j < track.length; j++) {
                let segment = track[j];
                let segmentEnd = segment.start+segment.duration;

                if (playhead > segmentEnd){
                    finishedPlaying.push(segment);
                    continue;
                }
                if (playhead > segment.start && playhead < segmentEnd){
                    currentlyPlaying.push(segment);
                    continue;
                }
                if(playhead <= segment.start){
                    toPlay.push(segment);
                    continue;
                }
            };
        }

        return [toPlay, currentlyPlaying, finishedPlaying];
    }

    _sortMediaSourcesByStartTime(mediaSources){
        mediaSources.sort(function(a,b){
            return a.start - b.start;
        });
        return mediaSources;
    }


    _loadMediaSource(mediaSourceReference){
        switch (mediaSourceReference.type){
            case "video":
                let video = new VideoSource(mediaSourceReference);
                video.load();
                this._mediaSources.set(mediaSourceReference.id, video);
                break;
            case "image":
                let image = new ImageSource(mediaSourceReference);
                image.load();
                this._mediaSources.set(mediaSourceReference.id, image);
                break;
            case "canvas":
                let canvas = new CanvasSource(mediaSourceReference);
                canvas.load();
                this._mediaSources.set(mediaSourceReference.id, canvas);
                break;
            default:
                throw {"error":2,"msg":"mediaSourceReference "+mediaSourceReference.id+" has unrecognized type "+mediaSourceReference.type, toString:function(){console.log(this.msg);}};
                break;
        }
    }

    update(dt){
        if (this._playlist === undefined || this._playing === false) return;

        let [toPlay, currentlyPlaying, finishedPlaying] = this._getPlaylistStatusAtTime(this._playlist, this._currentTime);
        toPlay = this._sortMediaSourcesByStartTime(toPlay);

        //Check if we've finished playing and then stop
        if (toPlay.length === 0 && currentlyPlaying.length === 0){
            this.pause();
            this.currentTime = 0;
            return;
        }


        //Preload mediaSources
        for (let i = 0; i < this._mediaSourcePreloadNumber; i++) {
            if (i === toPlay.length) break;
            if (this._mediaSources.has(toPlay[i].id) === false){
                this._loadMediaSource(toPlay[i]);
            }
        };

        //Clean-up any mediaSources which have already been played
        for (let i = 0; i < finishedPlaying.length; i++) {
            let mediaSourceReference = finishedPlaying[i];
            if (this._mediaSources.has(mediaSourceReference.id)){
                let mediaSource = this._mediaSources.get(mediaSourceReference.id);
                mediaSource.destroy();
                this._mediaSources.delete(mediaSourceReference.id);
            }
        };

        //Play mediaSources on the currently playing queue.
        let w = this._canvas.width;
        let h = this._canvas.height;
        currentlyPlaying.reverse(); //reverse the currently playing queue so track 0 renders last

        for (var i = 0; i < currentlyPlaying.length; i++) {
            let mediaSourceID = currentlyPlaying[i].id;
            let mediaSource = this._mediaSources.get(mediaSourceID);
            mediaSource.play();
            this._ctx.drawImage(mediaSource.render(), 0, 0, w, h);
        };
        this._currentTime += dt;
    }



    static calculateTrackDuration(track){
        let maxPlayheadPosition = 0;
        for (let j = 0; j < track.length; j++) {
            let playheadPosition = track[j].start + track[j].duration;
            if (playheadPosition > maxPlayheadPosition){
                maxPlayheadPosition = playheadPosition;
            }
        };
        return maxPlayheadPosition;
    }

    static calculatePlaylistDuration(playlist){
        let maxTrackDuration = 0;

        for(let i = 0; i < playlist.tracks.length; i++){
            let track = playlist.tracks[i];
            let trackDuration = VideoCompositor.calculateTrackDuration(track);
            if (trackDuration > maxTrackDuration){
                maxTrackDuration = trackDuration;
            }
        }

        return maxTrackDuration;
    }

    static validatePlaylist(playlist){
        /*     
        This function validates a passed playlist, making sure it matches a 
        number of properties a playlist must have to be OK.
        
        * Error 1. The playlist media sources have all the expected properties.
        * Error 2. Media sources in single track are sequential.
        * Error 3. Media sources in single track don't overlap
        */


        //Error 1. The playlist media sources have all the expected properties.
        for (let i = 0; i < playlist.tracks.length; i++) {
            let track = playlist.tracks[i]
            for (let j = 0; j < track.length; j++) {
                let mediaSource = track[j];
                if (mediaSource.id === undefined) throw {"error":2,"msg":"mediaSource "+mediaSource.id+" in track " +i+" is missing a id property", toString:function(){console.log(this.msg);}};
                if (mediaSource.start === undefined) throw {"error":2,"msg":"mediaSource "+mediaSource.id+" in track " +i+" is missing a start property", toString:function(){console.log(this.msg);}};
                if (mediaSource.duration === undefined) throw {"error":2,"msg":"mediaSource "+mediaSource.id+" in track " +i+" is missing a duration property", toString:function(){console.log(this.msg);}};
                if (mediaSource.type === undefined) throw {"error":2,"msg":"mediaSource "+mediaSource.id+" in track " +i+" is missing a type property", toString:function(){console.log(this.msg);}};
                if (mediaSource.src != undefined && mediaSource.element != undefined)throw {"error":2,"msg":"mediaSource "+mediaSource.id+" in track " +i+" has both a src and element, it must have one or the other", toString:function(){console.log(this.msg);}};
                if (mediaSource.src === undefined && mediaSource.element === undefined)throw {"error":2,"msg":"mediaSource "+mediaSource.id+" in track " +i+" has neither a src or an element, it must have one or the other", toString:function(){console.log(this.msg);}};                
            }
        }


        // Error 2. Media sources in single track are sequential.
        for (let i = 0; i < playlist.tracks.length; i++) {
            let track = playlist.tracks[i]
            let time = 0;
            for (let j = 0; j < track.length; j++) {
                let mediaSource = track[j];
                if (mediaSource.start < time){
                    throw {"error":2,"msg":"mediaSource "+mediaSource.id+" in track " +i+" starts before previous mediaSource", toString:function(){console.log(this.msg);}};
                }
                time = mediaSource.start;
            }
        }        


        //Error 3. Media sources in single track don't overlap
        for (let i = 0; i < playlist.tracks.length; i++) {
            let track = playlist.tracks[i]
            let previousMediaSource = undefined;
            for (let j = 0; j < track.length; j++) {
                let mediaSource = track[j];
                if (previousMediaSource === undefined){
                    previousMediaSource = mediaSource;
                    continue;
                }
                let previousEnd = previousMediaSource.start + previousMediaSource.duration;
                let currentStart = mediaSource.start;
                if (previousEnd > currentStart){
                    throw {"error":2,"msg":"Track mediaSource overlap. mediaSource "+previousMediaSource.id+" in track " +i+" finishes after mediaSource " + mediaSource.id +" starts.", toString:function(){console.log(this.msg);}};
                }
            }
        }
    }

    static renderPlaylist(playlist, canvas, currentTime){
        let ctx = canvas.getContext('2d');
        let w = canvas.width;
        let h = canvas.height;
        let trackHeight = h / playlist.tracks.length;
        let playlistDuration = VideoCompositor.calculatePlaylistDuration(playlist);
        let pixelsPerSecond = w / playlistDuration;
        let mediaSourceStyle = {
            "video":"#a5a",
            "image":"#5aa",
            "canvas":"#aa5",
        }


        ctx.clearRect(0,0,w,h);
        ctx.fillStyle = "#999";
        for (let i = 0; i < playlist.tracks.length; i++) {
            let track = playlist.tracks[i];
            for (let j = 0; j < track.length; j++) {
                let mediaSource = track[j];
                let msW = mediaSource.duration * pixelsPerSecond;
                let msH = trackHeight;
                let msX = mediaSource.start * pixelsPerSecond;
                let msY = trackHeight * i;
                ctx.fillStyle = mediaSourceStyle[mediaSource.type];
                ctx.fillRect(msX,msY,msW,msH);
                ctx.fill();
            };
        };

        if (currentTime !== undefined){
            ctx.fillStyle = "#000";
            ctx.fillRect(currentTime*pixelsPerSecond, 0, 1, h);
        }
    }
}

export default VideoCompositor;