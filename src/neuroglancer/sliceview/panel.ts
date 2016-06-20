/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {AxesLineHelper} from 'neuroglancer/axes_lines';
import {DisplayContext} from 'neuroglancer/display_context';
import {MouseSelectionState, RenderLayer, VisibleRenderLayerTracker} from 'neuroglancer/layer';
import {PickIDManager} from 'neuroglancer/object_picking';
import {RenderedDataPanel} from 'neuroglancer/rendered_data_panel';
import {SliceView, SliceViewRenderHelper} from 'neuroglancer/sliceview/frontend';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {Mat4, identityMat4, mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {ViewerState} from 'neuroglancer/viewer_state';
import {OffscreenCopyHelper, OffscreenFramebuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {ScaleBarWidget} from 'neuroglancer/widget/scale_bar';
import {Signal} from 'signals';

export interface SliceViewerState extends ViewerState { showScaleBar: TrackableBoolean; }

export enum OffscreenTextures {
  COLOR,
  PICK,
  NUM_TEXTURES
}

export function sliceViewPanelEmit(builder: ShaderBuilder) {
  builder.addFragmentExtension('GL_EXT_draw_buffers');
  builder.addFragmentCode(`
void emit(vec4 color, vec4 pickId) {
  gl_FragData[${OffscreenTextures.COLOR}] = color;
  gl_FragData[${OffscreenTextures.PICK}] = pickId;
}
`);
}

export interface SliceViewPanelRenderContext {
  dataToDevice: Mat4;
  pickIDs: PickIDManager;
}

export class SliceViewPanelRenderLayer extends RenderLayer {
  redrawNeeded = new Signal();
  draw(renderContext: SliceViewPanelRenderContext) {
    // Must be overriden by subclass.
  }
};

export class SliceViewPanel extends RenderedDataPanel {
  private axesLineHelper = AxesLineHelper.get(this.gl);
  private sliceViewRenderHelper =
      SliceViewRenderHelper.get(this.gl, 'SliceViewRenderHelper', sliceViewPanelEmit);
  private colorFactor = vec4.fromValues(1, 1, 1, 1);
  private backgroundColor = vec4.fromValues(0.5, 0.5, 0.5, 1.0);
  private pickIDs = new PickIDManager();

  private visibleLayerTracker =
      this.registerDisposer(new VisibleRenderLayerTracker<SliceViewPanelRenderLayer>(
          this.viewer.layerManager, SliceViewPanelRenderLayer,
          layer => {
            layer.redrawNeeded.add(this.scheduleRedraw, this);
            this.scheduleRedraw();
          },
          layer => {
            layer.redrawNeeded.remove(this.scheduleRedraw, this);
            this.scheduleRedraw();
          }));

  private offscreenFramebuffer =
      new OffscreenFramebuffer(this.gl, {numDataBuffers: OffscreenTextures.NUM_TEXTURES});

  private offscreenCopyHelper = OffscreenCopyHelper.get(this.gl);

  private scaleBarWidget = this.registerDisposer(new ScaleBarWidget());

  get navigationState() { return this.sliceView.navigationState; }

  constructor(
      context: DisplayContext, element: HTMLElement, public sliceView: SliceView,
      viewer: SliceViewerState) {
    super(context, element, viewer);

    this.registerDisposer(sliceView);
    this.registerSignalBinding(sliceView.viewChanged.add(context.scheduleRedraw, context));
    this.registerSignalBinding(viewer.showAxisLines.changed.add(() => { this.scheduleRedraw(); }));

    {
      let scaleBar = this.scaleBarWidget.element;
      this.registerDisposer(
          new ElementVisibilityFromTrackableBoolean(viewer.showScaleBar, scaleBar));
      this.element.appendChild(scaleBar);
    }
  }

  draw() {
    let {sliceView} = this;
    if (!sliceView.hasValidViewport) {
      return;
    }
    sliceView.updateRendering();

    let {gl} = this;

    let {width, height, dataToDevice} = sliceView;
    this.offscreenFramebuffer.bind(width, height);
    gl.disable(gl.SCISSOR_TEST);
    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Draw axes lines.
    // FIXME: avoid use of temporary matrix
    let mat = mat4.create();

    this.sliceViewRenderHelper.draw(
        sliceView.offscreenFramebuffer.dataTextures[0], identityMat4, this.colorFactor,
        this.backgroundColor, 0, 0, 1, 1);

    let visibleLayers = this.visibleLayerTracker.getVisibleLayers();
    let {pickIDs} = this;
    pickIDs.clear();
    let renderContext = {dataToDevice: sliceView.dataToDevice, pickIDs: pickIDs};

    for (let renderLayer of visibleLayers) {
      renderLayer.draw(renderContext);
    }

    if (this.viewer.showAxisLines.value) {
      // Construct matrix that maps [-1, +1] x/y range to the full viewport data
      // coordinates.
      mat4.copy(mat, dataToDevice);
      for (let i = 0; i < 3; ++i) {
        mat[12 + i] = 0;
      }

      for (let i = 0; i < 4; ++i) {
        mat[2 + 4 * i] = 0;
      }


      let axisLength = Math.min(width, height) / 4 * 1.5;
      let pixelSize = sliceView.pixelSize;
      for (let i = 0; i < 12; ++i) {
        // pixelSize is nm / pixel
        //
        mat[i] *= axisLength * pixelSize;
      }
      gl.WEBGL_draw_buffers.drawBuffersWEBGL([gl.WEBGL_draw_buffers.COLOR_ATTACHMENT0_WEBGL]);
      this.axesLineHelper.draw(mat);
    }

    this.offscreenFramebuffer.unbind();

    // Draw the texture over the whole viewport.
    this.setGLViewport();
    this.offscreenCopyHelper.draw(this.offscreenFramebuffer.dataTextures[OffscreenTextures.COLOR]);

    // Update the scale bar if needed.
    {
      let {scaleBarWidget} = this;
      let {dimensions} = scaleBarWidget;
      dimensions.targetLengthInPixels = Math.min(width / 4, 100);
      dimensions.nanometersPerPixel = sliceView.pixelSize;
      scaleBarWidget.update();
    }
  }

  onResize() {
    this.sliceView.setViewportSize(this.element.clientWidth, this.element.clientHeight);
  }

  updateMouseState(mouseState: MouseSelectionState) {
    mouseState.pickedRenderLayer = null;
    let sliceView = this.sliceView;
    if (!sliceView.hasValidViewport) {
      return false;
    }
    let {width, height} = sliceView;
    let {offscreenFramebuffer} = this;
    if (!offscreenFramebuffer.hasSize(width, height)) {
      return false;
    }
    let out = mouseState.position;
    let glWindowX = this.mouseX;
    let y = this.mouseY;
    vec3.set(out, glWindowX - width / 2, y - height / 2, 0);
    vec3.transformMat4(out, out, sliceView.viewportToData);

    let glWindowY = height - y;
    this.pickIDs.setMouseState(
        mouseState,
        offscreenFramebuffer.readPixelAsUint32(OffscreenTextures.PICK, glWindowX, glWindowY));
    return true;
  }

  onMousedown(e: MouseEvent) {
    if (event.target !== this.element) {
      return;
    }
    super.onMousedown(e);
    if (!this.sliceView.hasValidViewport) {
      return;
    }
    if (e.button === 0) {
      let {mouseState} = this.viewer;
      if (mouseState.updateUnconditionally()) {
        let initialPosition = vec3.clone(this.viewer.mouseState.position);
        startRelativeMouseDrag(e, (event, deltaX, deltaY) => {
          let {position} = this.viewer.navigationState;
          if (event.shiftKey) {
            let {viewportAxes} = this.sliceView;
            this.viewer.navigationState.pose.rotateAbsolute(
                viewportAxes[1], deltaX / 4.0 * Math.PI / 180.0, initialPosition);
            this.viewer.navigationState.pose.rotateAbsolute(
                viewportAxes[0], deltaY / 4.0 * Math.PI / 180.0, initialPosition);
          } else {
            let pos = position.spatialCoordinates;
            vec3.set(pos, deltaX, deltaY, 0);
            vec3.transformMat4(pos, pos, this.sliceView.viewportToData);
            position.changed.dispatch();
          }
        });
      }
    }
  }

  /**
   * Zooms by the specified factor, maintaining the data position that projects to the current mouse
   * position.
   */
  zoomByMouse(factor: number) {
    let {navigationState} = this;
    if (!navigationState.valid) {
      return;
    }
    let {sliceView} = this;
    let {width, height} = sliceView;
    let {mouseX, mouseY} = this;
    mouseX -= width / 2;
    mouseY -= height / 2;
    let oldZoom = this.navigationState.zoomFactor.value;
    // oldPosition + (mouseX * viewportAxes[0] + mouseY * viewportAxes[1]) * oldZoom
    //     === newPosition + (mouseX * viewportAxes[0] + mouseY * viewportAxes[1]) * newZoom

    // Therefore, we compute newPosition by:
    // newPosition = oldPosition + (viewportAxes[0] * mouseX +
    //                              viewportAxes[1] * mouseY) * (oldZoom - newZoom).
    navigationState.zoomBy(factor);
    let newZoom = navigationState.zoomFactor.value;

    let {spatialCoordinates} = navigationState.position;
    vec3.scaleAndAdd(
        spatialCoordinates, spatialCoordinates, sliceView.viewportAxes[0],
        mouseX * (oldZoom - newZoom));
    vec3.scaleAndAdd(
        spatialCoordinates, spatialCoordinates, sliceView.viewportAxes[1],
        mouseY * (oldZoom - newZoom));
    navigationState.position.changed.dispatch();
  }
};
