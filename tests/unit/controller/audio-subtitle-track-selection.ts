import { expect } from 'chai';
import AudioTrackController from '../../../src/controller/audio-track-controller';
import SubtitleTrackController from '../../../src/controller/subtitle-track-controller';
import { Events } from '../../../src/events';
import Hls from '../../../src/hls';
import { LoadStats } from '../../../src/loader/load-stats';
import M3U8Parser from '../../../src/loader/m3u8-parser';
import { Level } from '../../../src/types/level';
import type {
  ComponentAPI,
  NetworkComponentAPI,
} from '../../../src/types/component-api';
import type { MediaPlaylist } from '../../../src/types/media-playlist';

type HlsTestable = Omit<
  Hls,
  'levelController' | 'networkControllers' | 'coreComponents'
> & {
  levelController: {
    levels: Level[];
  };
  coreComponents: ComponentAPI[];
  networkControllers: NetworkComponentAPI[];
};

// Two variants, each referencing its own audio and subtitle rendition group.
// The rendition names in one variant's groups do not appear in the other's,
// so switching variants exercises the cross-group fallback matching.
const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="解说",LANGUAGE="zh",CHANNELS="2",URI="a1.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="环绕",LANGUAGE="zh",DEFAULT=YES,CHANNELS="6",URI="a2.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="英文",LANGUAGE="en",FORCED=YES,URI="s1.vtt"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="中文",LANGUAGE="zh",DEFAULT=YES,URI="s0.vtt"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac2",NAME="现场",LANGUAGE="zh",DEFAULT=YES,CHANNELS="2",URI="b0.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac2",NAME="评述",LANGUAGE="zh",CHANNELS="2",URI="b1.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac2",NAME="全景",LANGUAGE="en",CHANNELS="6",URI="b2.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub2",NAME="英语注释",LANGUAGE="en",DEFAULT=YES,URI="t0.vtt"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub2",NAME="英文字幕",LANGUAGE="en",FORCED=YES,URI="t1.vtt"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aac",SUBTITLES="sub"
http://cdn.example/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,AUDIO="aac2",SUBTITLES="sub2"
http://cdn.example/mid.m3u8`;

describe('Audio and subtitle track selection across variants', function () {
  let hls: HlsTestable;
  let levels: Level[];

  function selectedAudioTrack(): MediaPlaylist {
    return hls.audioTracks[hls.audioTrack];
  }

  function selectedSubtitleTrack(): MediaPlaylist {
    return hls.subtitleTracks[hls.subtitleTrack];
  }

  function loadLevel(level: number) {
    hls.trigger(Events.LEVEL_LOADING, {
      id: level,
      level,
      levelInfo: levels[level],
      pathwayId: undefined,
      url: levels[level].uri,
      deliveryDirectives: null,
    });
  }

  beforeEach(function () {
    const baseUrl = 'http://cdn.example/master.m3u8';
    const parsed = M3U8Parser.parseMasterPlaylist(MASTER_PLAYLIST, baseUrl);
    expect(parsed.playlistParsingError).to.be.null;
    const media = M3U8Parser.parseMasterPlaylistMedia(
      MASTER_PLAYLIST,
      baseUrl,
      parsed,
    );
    levels = parsed.levels.map((levelParsed) => new Level(levelParsed));
    const audioTracks = media.AUDIO || [];
    const subtitleTracks = media.SUBTITLES || [];

    hls = new Hls({
      enableWebVTT: true,
      enableIMSC1: false,
    }) as unknown as HlsTestable;
    hls.networkControllers.forEach((component) => component.destroy());
    hls.networkControllers.length = 0;
    hls.coreComponents.forEach((component) => component.destroy());
    hls.coreComponents.length = 0;
    const audioTrackController = new AudioTrackController(
      hls as unknown as Hls,
    );
    const subtitleTrackController = new SubtitleTrackController(
      hls as unknown as Hls,
    );
    (hls as any).audioTrackController = audioTrackController;
    (hls as any).subtitleTrackController = subtitleTrackController;
    hls.networkControllers.push(audioTrackController, subtitleTrackController);
    hls.levelController = { levels };

    hls.trigger(Events.MANIFEST_PARSED, {
      levels,
      audioTracks,
      subtitleTracks,
      iframeVariants: [],
      sessionData: null,
      sessionKeys: null,
      firstLevel: 0,
      stats: new LoadStats(),
      audio: true,
      video: true,
      altAudio: true,
    });
    hls.trigger(Events.MEDIA_ATTACHED, {
      media: document.createElement('video'),
    });
  });

  afterEach(function () {
    hls.destroy();
  });

  it('maps each variant to its own audio and subtitle groups', function () {
    expect(levels[0].bitrate).to.equal(800000);
    expect(levels[0].uri).to.equal('http://cdn.example/low.m3u8');
    expect(levels[0].audioGroups).to.deep.equal(['aac']);
    expect(levels[0].subtitleGroups).to.deep.equal(['sub']);
    expect(levels[1].bitrate).to.equal(1400000);
    expect(levels[1].uri).to.equal('http://cdn.example/mid.m3u8');
    expect(levels[1].audioGroups).to.deep.equal(['aac2']);
    expect(levels[1].subtitleGroups).to.deep.equal(['sub2']);
  });

  describe('with the 800kbps variant loaded', function () {
    beforeEach(function () {
      loadLevel(0);
    });

    it('offers the renditions of the "aac" and "sub" groups', function () {
      expect(hls.audioTracks.map((track) => track.name)).to.deep.equal([
        '解说',
        '环绕',
      ]);
      expect(hls.subtitleTracks.map((track) => track.name)).to.deep.equal([
        '英文',
        '中文',
      ]);
    });

    it('plays the default surround sound and Chinese subtitles on open', function () {
      expect(selectedAudioTrack().name).to.equal('环绕');
      expect(selectedAudioTrack().url).to.equal('http://cdn.example/a2.m3u8');
      expect(selectedSubtitleTrack().name).to.equal('中文');
      expect(selectedSubtitleTrack().url).to.equal('http://cdn.example/s0.vtt');
    });

    it('selects the commentary audio for language "zh" with 2 channels', function () {
      const track = hls.setAudioOption({ lang: 'zh', channels: '2' });
      expect(track?.name).to.equal('解说');
      expect(selectedAudioTrack().name).to.equal('解说');
      expect(selectedAudioTrack().url).to.equal('http://cdn.example/a1.m3u8');
    });

    it('selects the English subtitles for language "en" and forced', function () {
      const track = hls.setSubtitleOption({ lang: 'en', forced: true });
      expect(track?.name).to.equal('英文');
      expect(selectedSubtitleTrack().name).to.equal('英文');
      expect(selectedSubtitleTrack().url).to.equal('http://cdn.example/s1.vtt');
    });

    describe('and switching to the 1400kbps variant', function () {
      beforeEach(function () {
        // Select renditions whose names do not exist in the new groups
        hls.setAudioOption({ lang: 'zh', channels: '2' }); // 解说
        hls.setSubtitleOption({ lang: 'en', forced: true }); // 英文
        loadLevel(1);
      });

      it('offers the renditions of the "aac2" and "sub2" groups', function () {
        expect(hls.audioTracks.map((track) => track.name)).to.deep.equal([
          '现场',
          '评述',
          '全景',
        ]);
        expect(hls.subtitleTracks.map((track) => track.name)).to.deep.equal([
          '英语注释',
          '英文字幕',
        ]);
      });

      it('falls back within the new groups when rendition names are gone', function () {
        // "解说" is not in "aac2": the first zh match is the default "现场"
        // (not "评述" and not "全景")
        expect(selectedAudioTrack().name).to.equal('现场');
        expect(selectedAudioTrack().url).to.equal('http://cdn.example/b0.m3u8');
        // "英文" is not in "sub2": the first en match is the default
        // "英语注释" (not the forced "英文字幕")
        expect(selectedSubtitleTrack().name).to.equal('英语注释');
        expect(selectedSubtitleTrack().url).to.equal(
          'http://cdn.example/t0.vtt',
        );
      });

      it('selects "现场" for language "zh" alone', function () {
        hls.setAudioOption({ lang: 'zh' });
        expect(selectedAudioTrack().name).to.equal('现场');
        expect(selectedAudioTrack().channels).to.equal('2');
      });

      it('selects "英语注释" for language "en" and not forced', function () {
        hls.setSubtitleOption({ lang: 'en', forced: false });
        expect(selectedSubtitleTrack().name).to.equal('英语注释');
      });

      it('selects "全景" for language "en" with 6 channels', function () {
        hls.setAudioOption({ lang: 'en', channels: '6' });
        expect(selectedAudioTrack().name).to.equal('全景');
        expect(selectedAudioTrack().url).to.equal('http://cdn.example/b2.m3u8');
      });

      it('selects "英文字幕" for language "en" and forced', function () {
        hls.setSubtitleOption({ lang: 'en', forced: true });
        expect(selectedSubtitleTrack().name).to.equal('英文字幕');
        expect(selectedSubtitleTrack().url).to.equal(
          'http://cdn.example/t1.vtt',
        );
      });
    });
  });
});
