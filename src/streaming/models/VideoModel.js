/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import FactoryMaker from '../../core/FactoryMaker.js';
import EventBus from '../../core/EventBus.js';
import Events from '../../core/events/Events.js';
import Debug from '../../core/Debug.js';
import Constants from '../constants/Constants.js';
import Settings from '../../core/Settings.js';


const READY_STATES_TO_EVENT_NAMES = new Map([
    [Constants.VIDEO_ELEMENT_READY_STATES.HAVE_METADATA, 'loadedmetadata'],
    [Constants.VIDEO_ELEMENT_READY_STATES.HAVE_CURRENT_DATA, 'loadeddata'],
    [Constants.VIDEO_ELEMENT_READY_STATES.HAVE_FUTURE_DATA, 'canplay'],
    [Constants.VIDEO_ELEMENT_READY_STATES.HAVE_ENOUGH_DATA, 'canplaythrough']
]);

function VideoModel() {

    let instance,
        logger,
        settings,
        element,
        _currentTime,
        setCurrentTimeReadyStateFunction,
        resumeReadyStateFunction,
        TTMLRenderingDiv,
        vttRenderingDiv,
        previousPlaybackRate,
        timeout;

    const VIDEO_MODEL_WRONG_ELEMENT_TYPE = 'element is not video or audio DOM type!';

    const context = this.context;
    const eventBus = EventBus(context).getInstance();
    const stalledStreams = [];

    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
        settings = Settings(context).getInstance();
        _currentTime = NaN;
    }

    function initialize() {
        eventBus.on(Events.PLAYBACK_PLAYING, onPlaying, this);
    }

    function reset() {
        clearTimeout(timeout);
        eventBus.off(Events.PLAYBACK_PLAYING, onPlaying, this);
        stalledStreams.length = 0;
    }

    function setConfig(config) {
        if (!config) {
            return;
        }

        if (config.settings) {
            settings = config.settings;
        }
    }

    function setPlaybackRate(value, ignoreReadyState = false) {
        if (!element) {
            return;
        }

        if (ignoreReadyState) {
            element.playbackRate = value;
            return;
        }

        // If media element hasn't loaded enough data to play yet, wait until it has
        waitForReadyState(Constants.VIDEO_ELEMENT_READY_STATES.HAVE_FUTURE_DATA, () => {
            element.playbackRate = value;
        });
    }

    //TODO Move the DVR window calculations from MediaPlayer to Here.
    function setCurrentTime(currentTime, stickToBuffered) {
        if (element) {
            if (setCurrentTimeReadyStateFunction && setCurrentTimeReadyStateFunction.func && setCurrentTimeReadyStateFunction.event) {
                removeEventListener(setCurrentTimeReadyStateFunction.event, setCurrentTimeReadyStateFunction.func);
            }
            _currentTime = currentTime;
            setCurrentTimeReadyStateFunction = waitForReadyState(Constants.VIDEO_ELEMENT_READY_STATES.HAVE_METADATA, () => {
                if (!element) {
                    return;
                }

                // We don't set the same currentTime because it can cause firing unexpected Pause event in IE11
                // providing playbackRate property equals to zero.
                if (element.currentTime === _currentTime) {
                    _currentTime = NaN;
                    return;
                }

                // TODO Despite the fact that MediaSource 'open' event has been fired IE11 cannot set videoElement.currentTime
                // immediately (it throws InvalidStateError). It seems that this is related to videoElement.readyState property
                // Initially it is 0, but soon after 'open' event it goes to 1 and setting currentTime is allowed. Chrome allows to
                // set currentTime even if readyState = 0.
                // setTimeout is used to workaround InvalidStateError in IE11
                try {
                    _currentTime = stickToBuffered ? stickTimeToBuffered(_currentTime) : _currentTime;
                    if (!isNaN(_currentTime)) {
                        element.currentTime = _currentTime;
                    }
                    _currentTime = NaN;
                } catch (e) {
                    if (element.readyState === 0 && e.code === e.INVALID_STATE_ERR) {
                        timeout = setTimeout(function () {
                            element.currentTime = _currentTime;
                            _currentTime = NaN;
                        }, 400);
                    }
                }
            });
        }
    }

    function stickTimeToBuffered(time) {
        const buffered = getBufferRange();
        let closestTime = time;
        let closestDistance = 9999999999;
        if (buffered) {
            for (let i = 0; i < buffered.length; i++) {
                const start = buffered.start(i);
                const end = buffered.end(i);
                const distanceToStart = Math.abs(start - time);
                const distanceToEnd = Math.abs(end - time);

                if (time >= start && time <= end) {
                    return time;
                }

                if (distanceToStart < closestDistance) {
                    closestDistance = distanceToStart;
                    closestTime = start;
                }

                if (distanceToEnd < closestDistance) {
                    closestDistance = distanceToEnd;
                    closestTime = end;
                }
            }
        }
        return closestTime;
    }

    function getElement() {
        return element;
    }

    function setElement(value) {
        //add check of value type
        if (value === null || value === undefined || (value && (/^(VIDEO|AUDIO)$/i).test(value.nodeName))) {
            element = value;
            // Workaround to force Firefox to fire the canplay event.
            if (element) {
                element.preload = 'auto';
            }
        } else {
            throw VIDEO_MODEL_WRONG_ELEMENT_TYPE;
        }
    }

    function setSource(source) {
        if (element) {
            if (source) {
                element.src = source;
            } else {
                element.removeAttribute('src');
                element.load();
            }
        }
    }

    function setDisableRemotePlayback(value) {
        if (element) {
            element.disableRemotePlayback = value;
        }
    }

    function getSource() {
        return element ? element.src : null;
    }

    function getTTMLRenderingDiv() {
        return TTMLRenderingDiv;
    }

    function getVttRenderingDiv() {
        return vttRenderingDiv;
    }

    function setTTMLRenderingDiv(div) {
        TTMLRenderingDiv = div;
        // The styling will allow the captions to match the video window size and position.
        TTMLRenderingDiv.style.position = 'absolute';
        TTMLRenderingDiv.style.display = 'flex';
        TTMLRenderingDiv.style.overflow = 'hidden';
        TTMLRenderingDiv.style.pointerEvents = 'none';
        TTMLRenderingDiv.style.top = 0;
        TTMLRenderingDiv.style.left = 0;
    }

    function setVttRenderingDiv(div) {
        vttRenderingDiv = div;
    }

    function setStallState(type, state) {
        stallStream(type, state);
    }

    function isStalled() {
        return (stalledStreams.length > 0);
    }

    function addStalledStream(type) {
        if (type === null || !element || element.seeking || stalledStreams.indexOf(type) !== -1) {
            return;
        }

        stalledStreams.push(type);

        if (settings.get().streaming.buffer.syntheticStallEvents.enabled && element && stalledStreams.length === 1 && (settings.get().streaming.buffer.syntheticStallEvents.ignoreReadyState || getReadyState() >= Constants.VIDEO_ELEMENT_READY_STATES.HAVE_FUTURE_DATA)) {
            // Halt playback until nothing is stalled
            previousPlaybackRate = element.playbackRate;
            setPlaybackRate(0, true);

            const event = document.createEvent('Event');
            event.initEvent('waiting', true, false);
            element.dispatchEvent(event);
        }
    }

    function removeStalledStream(type) {
        let index = stalledStreams.indexOf(type);

        if (type === null) {
            return;
        }
        if (index !== -1) {
            stalledStreams.splice(index, 1);
        }

        if (settings.get().streaming.buffer.syntheticStallEvents.enabled && element && !isStalled()) {
            const resume = () => {
                setPlaybackRate(previousPlaybackRate || 1, settings.get().streaming.buffer.syntheticStallEvents.ignoreReadyState);

                if (!element.paused) {
                    const event = document.createEvent('Event');
                    event.initEvent('playing', true, false);
                    element.dispatchEvent(event);
                }
            }
            
            if (settings.get().streaming.buffer.syntheticStallEvents.ignoreReadyState) {
                resume();
            } else {
                if (resumeReadyStateFunction && resumeReadyStateFunction.func && resumeReadyStateFunction.event) {
                    removeEventListener(resumeReadyStateFunction.event, resumeReadyStateFunction.func);
                }
                resumeReadyStateFunction = waitForReadyState(Constants.VIDEO_ELEMENT_READY_STATES.HAVE_FUTURE_DATA, resume);
            }
        }
    }

    function stallStream(type, isStalled) {
        if (isStalled) {
            addStalledStream(type);
        } else {
            removeStalledStream(type);
        }
    }

    //Calling play on the element will emit playing - even if the stream is stalled. If the stream is stalled, emit a waiting event.
    function onPlaying() {
        if (element && isStalled() && element.playbackRate === 0) {
            const event = document.createEvent('Event');
            event.initEvent('waiting', true, false);
            element.dispatchEvent(event);
        }
    }

    function getPlaybackQuality() {
        if (!element) {
            return null;
        }
        let hasWebKit = ('webkitDroppedFrameCount' in element) && ('webkitDecodedFrameCount' in element);
        let hasQuality = ('getVideoPlaybackQuality' in element);
        let result = null;

        if (hasQuality) {
            result = element.getVideoPlaybackQuality();
        } else if (hasWebKit) {
            result = {
                droppedVideoFrames: element.webkitDroppedFrameCount,
                totalVideoFrames: element.webkitDroppedFrameCount + element.webkitDecodedFrameCount,
                creationTime: new Date()
            };
        }

        return result;
    }

    function play() {
        if (element) {
            element.autoplay = true;
            const p = element.play();
            if (p && p.catch && typeof Promise !== 'undefined') {
                p.catch((e) => {
                    if (e.name === 'NotAllowedError') {
                        eventBus.trigger(Events.PLAYBACK_NOT_ALLOWED);
                    }
                    logger.warn(`Caught pending play exception - continuing (${e})`);
                });
            }
        }
    }

    function isPaused() {
        return element ? element.paused : null;
    }

    function pause() {
        if (element) {
            element.pause();
            element.autoplay = false;
        }
    }

    function isSeeking() {
        return element ? (element.seeking || !isNaN(_currentTime)) : null;
    }

    function getTime() {
        return element ? (!isNaN(_currentTime) ? _currentTime : element.currentTime) : null;
    }

    function getPlaybackRate() {
        return element ? element.playbackRate : null;
    }

    function getPlayedRanges() {
        return element ? element.played : null;
    }

    function getEnded() {
        return element ? element.ended : null;
    }

    function addEventListener(eventName, eventCallBack) {
        if (element) {
            element.addEventListener(eventName, eventCallBack);
        }
    }

    function removeEventListener(eventName, eventCallBack) {
        if (element) {
            element.removeEventListener(eventName, eventCallBack);
        }
    }

    function getReadyState() {
        return element ? element.readyState : NaN;
    }

    function getBufferRange() {
        return element ? element.buffered : null;
    }

    function getClientWidth() {
        return element ? element.clientWidth : NaN;
    }

    function getClientHeight() {
        return element ? element.clientHeight : NaN;
    }

    function getVideoWidth() {
        return element ? element.videoWidth : NaN;
    }

    function getVideoHeight() {
        return element ? element.videoHeight : NaN;
    }

    function getVideoRelativeOffsetTop() {
        if (element) {
            const parentElement = element.parentNode.host || element.parentNode;
            return parentElement ? element.getBoundingClientRect().top - parentElement.getBoundingClientRect().top : NaN;
        }
        return NaN;
    }

    function getVideoRelativeOffsetLeft() {
        if (element) {
            const parentElement = element.parentNode.host || element.parentNode;
            return parentElement ? element.getBoundingClientRect().left - parentElement.getBoundingClientRect().left : NaN;
        }
        return NaN;
    }

    function getTextTracks() {
        return element ? element.textTracks : [];
    }

    function getTextTrack(kind, label, lang, isTTML, isEmbedded) {
        if (element) {
            for (let i = 0; i < element.textTracks.length; i++) {
                //label parameter could be a number (due to adaptationSet), but label, the attribute of textTrack, is a string => to modify...
                //label could also be undefined (due to adaptationSet)
                if (element.textTracks[i].kind === kind && (label ? element.textTracks[i].label == label : true) &&
                    element.textTracks[i].language === lang && element.textTracks[i].isTTML === isTTML && element.textTracks[i].isEmbedded === isEmbedded) {
                    return element.textTracks[i];
                }
            }
        }

        return null;
    }

    function addTextTrack(kind, label, lang, isTTML, isEmbedded) {
        if (!element) {
            return null;
        }
        // check if track of same type has not been already created for previous stream
        // then use it (no way to remove existing text track from video element)
        let track = getTextTrack(kind, label, lang, isTTML, isEmbedded);
        if (!track) {
            track = element.addTextTrack(kind, label, lang);
            track.isEmbedded = isEmbedded;
            track.isTTML = isTTML;
        }
        return track;
    }

    function appendChild(childElement) {
        if (element) {
            element.appendChild(childElement);
            //in Chrome, we need to differenciate textTrack with same lang, kind and label but different format (vtt, ttml, etc...)
            if (childElement.isTTML !== undefined) {
                element.textTracks[element.textTracks.length - 1].isTTML = childElement.isTTML;
                element.textTracks[element.textTracks.length - 1].isEmbedded = childElement.isEmbedded;
            }
        }
    }

    function removeChild(childElement) {
        if (element) {
            element.removeChild(childElement);
        }
    }

    function waitForReadyState(targetReadyState, callback) {
        if (targetReadyState === Constants.VIDEO_ELEMENT_READY_STATES.HAVE_NOTHING ||
            getReadyState() >= targetReadyState) {
            callback();
            return null;
        } else {
            // wait for the appropriate callback before checking again
            const event = READY_STATES_TO_EVENT_NAMES.get(targetReadyState);
            return _listenOnce(event, callback);
        }
    }

    function _listenOnce(event, callback) {
        const func = () => {
            // Stop listening to this event.
            removeEventListener(event, func);
            // Call the original listener.
            callback(event);
        };
        addEventListener(event, func);

        return { func, event }
    }

    function getVideoElementSize() {
        const hasPixelRatio = settings.get().streaming.abr.usePixelRatioInLimitBitrateByPortal && window.hasOwnProperty('devicePixelRatio');
        const pixelRatio = hasPixelRatio ? window.devicePixelRatio : 1;
        const elementWidth = getClientWidth() * pixelRatio;
        const elementHeight = getClientHeight() * pixelRatio;

        return {
            elementWidth,
            elementHeight
        }
    }

    instance = {
        addEventListener,
        addTextTrack,
        appendChild,
        getBufferRange,
        getClientHeight,
        getClientWidth,
        getElement,
        getEnded,
        getPlaybackQuality,
        getPlaybackRate,
        getPlayedRanges,
        getReadyState,
        getSource,
        getTTMLRenderingDiv,
        getTextTrack,
        getTextTracks,
        getTime,
        getVideoElementSize,
        getVideoHeight,
        getVideoRelativeOffsetLeft,
        getVideoRelativeOffsetTop,
        getVideoWidth,
        getVttRenderingDiv,
        initialize,
        isPaused,
        isSeeking,
        isStalled,
        pause,
        play,
        removeChild,
        removeEventListener,
        reset,
        setConfig,
        setCurrentTime,
        setDisableRemotePlayback,
        setElement,
        setPlaybackRate,
        setSource,
        setStallState,
        setTTMLRenderingDiv,
        setVttRenderingDiv,
        waitForReadyState,
    };

    setup();

    return instance;
}

VideoModel.__dashjs_factory_name = 'VideoModel';
export default FactoryMaker.getSingletonFactory(VideoModel);
